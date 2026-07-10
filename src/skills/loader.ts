/**
 * Skill loader: walks `<configDir>/skills/`, parses SKILL.md frontmatter, returns Skills.
 * `configDir` may be a single path or an array of paths walked in first-dir-wins order.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Skill, SkillFrontmatter, SkippedSkill } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const ARG_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const TOOL_NAME_RE = /^[^\s]+$/;

export interface LoadSkillsOptions {
  /**
   * Absolute path (or paths) to the config directory containing a `skills/`
   * subfolder. When several directories are given they are walked in array
   * order with first-directory-wins precedence: the first directory to define
   * a given skill name keeps it, and later duplicates are reported in `skipped`
   * with reason `name-collision-skill`.
   */
  configDir: string | string[];
  /** Names of currently registered builtin tools — used to detect skill/tool name collisions. */
  builtinToolNames: Set<string>;
}

export interface LoadSkillsResult {
  skills: Skill[];
  skipped: SkippedSkill[];
}

export async function loadSkillsFromDir(opts: LoadSkillsOptions): Promise<LoadSkillsResult> {
  const configDirs = Array.isArray(opts.configDir) ? opts.configDir : [opts.configDir];

  const skills: Skill[] = [];
  const skipped: SkippedSkill[] = [];
  // Collision state is shared across directories so precedence is first-dir-wins:
  // the first directory to define a name keeps it; later duplicates are skipped.
  const seenNames = new Set<string>();
  // Skill names are normalized to lowercase, so compare against builtins the same way.
  const builtinNamesLower = new Set([...opts.builtinToolNames].map((n) => n.toLowerCase()));

  for (const configDir of configDirs) {
    const skillsRoot = path.join(configDir, "skills");
    let entries;
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Missing skills/ directory is not an error — skip it (a single absent
      // dir behaves exactly as before this loader accepted multiple dirs).
      if (code === "ENOENT") continue;
      skipped.push({ dir: skillsRoot, reason: "io-error", detail: (err as Error).message });
      continue;
    }

    for (const ent of entries) {
      const entryDir = path.join(skillsRoot, ent.name);
      if (ent.isSymbolicLink()) {
        skipped.push({ dir: entryDir, reason: "io-error", detail: "symlinks are not followed" });
        continue;
      }
      if (!ent.isDirectory()) continue;

      const skillMdPath = path.join(entryDir, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(skillMdPath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          skipped.push({ dir: entryDir, reason: "missing-skill-md", detail: "SKILL.md not found" });
        } else {
          skipped.push({ dir: entryDir, reason: "io-error", detail: (err as Error).message });
        }
        continue;
      }

      const parsed = parseFrontmatter(raw, ent.name);
      if (!parsed.ok) {
        skipped.push({ dir: entryDir, reason: "invalid-frontmatter", detail: parsed.error });
        continue;
      }
      const { frontmatter, body } = parsed.value;

      if (builtinNamesLower.has(frontmatter.name)) {
        skipped.push({
          dir: entryDir,
          reason: "name-collision-tool",
          detail: `skill name '${frontmatter.name}' collides with builtin tool`,
        });
        continue;
      }
      if (seenNames.has(frontmatter.name)) {
        skipped.push({
          dir: entryDir,
          reason: "name-collision-skill",
          detail: `skill name '${frontmatter.name}' already loaded`,
        });
        continue;
      }
      seenNames.add(frontmatter.name);

      skills.push({ name: frontmatter.name, dir: entryDir, frontmatter, body });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, skipped };
}

type ParseResult =
  | { ok: true; value: { frontmatter: SkillFrontmatter; body: string } }
  | { ok: false; error: string };

class FrontmatterError extends Error {}
const fail = (msg: string): never => { throw new FrontmatterError(msg); };

function parseFrontmatter(raw: string, dirName: string): ParseResult {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { ok: false, error: "missing frontmatter (file must start with `---`)" };
  const yamlText = match[1] ?? "";
  const body = raw.slice(match[0].length);

  let doc: unknown;
  try {
    doc = parseYaml(yamlText, { strict: true });
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${(err as Error).message}` };
  }
  if (doc === null || doc === undefined) return { ok: false, error: "frontmatter is empty" };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "frontmatter must be a YAML mapping" };
  }

  const obj = doc as Record<string, unknown>;
  try {
    // Unknown keys are ignored — only the documented schema is consumed.
    // This keeps loader tolerant to skills authored against other harnesses
    // (e.g. Anthropic's Skills) that carry extra metadata like `license:`.

    const description = obj.description;
    if (typeof description !== "string" || description.trim() === "") {
      fail("frontmatter 'description' is required and must be a non-empty string");
    }

    let name = dirName;
    if (obj.name !== undefined) {
      if (typeof obj.name !== "string" || obj.name.trim() === "") {
        fail("frontmatter 'name' must be a non-empty string");
      }
      name = obj.name as string;
    }
    if (!SKILL_NAME_RE.test(name)) {
      fail(`skill name '${name}' must match /^[a-z0-9][a-z0-9_-]*$/i`);
    }
    // The grammar is case-insensitive but the registry keys and lookups are not;
    // normalize to lowercase so 'Foo' and 'foo' resolve identically and collide.
    name = name.toLowerCase();

    const args = optionalStringArray(obj, "arguments", ARG_NAME_RE, "must match /^[a-z_][a-z0-9_]*$/i");
    if (args) {
      const seen = new Set<string>();
      for (const a of args) {
        // Reject names that collide with the reserved `$ARGUMENTS` token, including
        // prefixes like `ARGUMENTSX` that the single-pass matcher would split.
        if (a.toUpperCase().startsWith("ARGUMENTS")) {
          fail(`frontmatter 'arguments' entry '${a}' must not start with 'ARGUMENTS' (reserved)`);
        }
        if (seen.has(a)) fail(`frontmatter 'arguments' contains duplicate '${a}'`);
        seen.add(a);
      }
    }

    let disableModelInvocation = false;
    if (obj.disable_model_invocation !== undefined) {
      if (typeof obj.disable_model_invocation !== "boolean") {
        fail("frontmatter 'disable_model_invocation' must be a boolean");
      }
      disableModelInvocation = obj.disable_model_invocation as boolean;
    }

    const frontmatter: SkillFrontmatter = {
      name,
      description: description as string,
      disableModelInvocation,
    };
    const whenToUse = optionalString(obj, "when_to_use");
    if (whenToUse !== undefined) frontmatter.whenToUse = whenToUse;
    const allowedTools = optionalStringArray(obj, "allowed_tools", TOOL_NAME_RE, "must look like tool names");
    if (allowedTools !== undefined) frontmatter.allowedTools = allowedTools;
    if (args !== undefined) frontmatter.arguments = args;
    const argumentHint = optionalString(obj, "argument_hint");
    if (argumentHint !== undefined) frontmatter.argumentHint = argumentHint;
    const model = optionalString(obj, "model");
    if (model !== undefined) frontmatter.model = model;
    const version = optionalString(obj, "version");
    if (version !== undefined) frontmatter.version = version;

    return { ok: true, value: { frontmatter, body } };
  } catch (err) {
    if (err instanceof FrontmatterError) return { ok: false, error: err.message };
    throw err;
  }
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") {
    fail(`frontmatter '${key}' must be a non-empty string`);
  }
  return v as string;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  itemRe: RegExp,
  itemDescription: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) fail(`frontmatter '${key}' must be an array of strings`);
  for (const item of v as unknown[]) {
    if (typeof item !== "string") fail(`frontmatter '${key}' must contain only strings`);
    if (!itemRe.test(item as string)) {
      fail(`frontmatter '${key}' entry '${item}' ${itemDescription}`);
    }
  }
  return v as string[];
}
