/**
 * Subagent loader: walks `<configDir>/agents/`, parses *.md frontmatter, returns AgentDefinitions.
 * `configDir` may be a single path or an array of paths walked in first-dir-wins order.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AgentDefinition,
  AgentFrontmatter,
  LoadAgentsResult,
  SkippedAgent,
} from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface LoadAgentsOptions {
  /**
   * Absolute path (or paths) to the config directory containing an `agents/`
   * subfolder. When several directories are given they are walked in array
   * order with first-directory-wins precedence: the first directory to define
   * a given agent name keeps it, and later duplicates are reported in `skipped`
   * with reason `name-collision`.
   */
  configDir: string | string[];
}

export async function loadAgentsFromDir(
  opts: LoadAgentsOptions,
): Promise<LoadAgentsResult> {
  const configDirs = Array.isArray(opts.configDir) ? opts.configDir : [opts.configDir];

  const agents: AgentDefinition[] = [];
  const skipped: SkippedAgent[] = [];
  // Shared across directories so precedence is first-dir-wins.
  const seenNames = new Set<string>();

  for (const configDir of configDirs) {
    const agentsRoot = path.join(configDir, "agents");
    let entries;
    try {
      entries = await readdir(agentsRoot, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Missing agents/ directory is not an error — skip it (a single absent
      // dir behaves exactly as before this loader accepted multiple dirs).
      if (code === "ENOENT") continue;
      skipped.push({ filePath: agentsRoot, reason: "io-error", detail: (err as Error).message });
      continue;
    }

    for (const ent of entries) {
      const filePath = path.join(agentsRoot, ent.name);
      if (ent.isSymbolicLink()) {
        skipped.push({ filePath, reason: "io-error", detail: "symlinks are not followed" });
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".md")) continue;

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        skipped.push({ filePath, reason: "io-error", detail: (err as Error).message });
        continue;
      }

      const fileBase = ent.name.replace(/\.md$/i, "");
      const parsed = parseFrontmatter(raw, fileBase);
      if (!parsed.ok) {
        skipped.push({ filePath, reason: parsed.reason, detail: parsed.error });
        continue;
      }
      const { frontmatter, body } = parsed.value;

      const key = frontmatter.name.toLowerCase();
      if (seenNames.has(key)) {
        skipped.push({
          filePath,
          reason: "name-collision",
          detail: `agent name '${frontmatter.name}' already loaded`,
        });
        continue;
      }
      seenNames.add(key);

      agents.push({
        name: frontmatter.name,
        filePath,
        source: "disk",
        frontmatter,
        body,
      });
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, skipped };
}

type ParseResult =
  | { ok: true; value: { frontmatter: AgentFrontmatter; body: string } }
  | { ok: false; reason: SkippedAgent["reason"]; error: string };

class FrontmatterError extends Error {}
const fail = (msg: string): never => {
  throw new FrontmatterError(msg);
};

function parseFrontmatter(raw: string, fileBase: string): ParseResult {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return {
      ok: false,
      reason: "missing-frontmatter",
      error: "missing frontmatter (file must start with `---`)",
    };
  }
  const yamlText = match[1] ?? "";
  const body = raw.slice(match[0].length);

  let doc: unknown;
  try {
    doc = parseYaml(yamlText, { strict: true });
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-frontmatter",
      error: `YAML parse error: ${(err as Error).message}`,
    };
  }
  if (doc === null || doc === undefined) {
    return { ok: false, reason: "invalid-frontmatter", error: "frontmatter is empty" };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      reason: "invalid-frontmatter",
      error: "frontmatter must be a YAML mapping",
    };
  }

  const obj = doc as Record<string, unknown>;
  try {
    // Unknown keys are ignored — only the documented schema is consumed.
    // This keeps the loader tolerant to agents authored against other harnesses
    // (e.g. Claude Code's `.claude/agents/*.md`) that carry extra metadata like
    // `model`, `provider`, `mcpServers`, `hooks`, `color`, `permissionMode`, etc.

    const description = obj.description;
    if (typeof description !== "string" || description.trim() === "") {
      fail("frontmatter 'description' is required and must be a non-empty string");
    }

    let name = fileBase;
    if (obj.name !== undefined) {
      if (typeof obj.name !== "string" || obj.name.trim() === "") {
        fail("frontmatter 'name' must be a non-empty string");
      }
      name = obj.name as string;
    }
    if (!AGENT_NAME_RE.test(name)) {
      fail(`agent name '${name}' must match /^[a-z0-9][a-z0-9_-]*$/i`);
    }

    const frontmatter: AgentFrontmatter = {
      name,
      description: description as string,
    };

    const normalizedTools = normalizeTools(obj.tools);
    if (normalizedTools !== undefined) frontmatter.tools = normalizedTools;

    return { ok: true, value: { frontmatter, body } };
  } catch (err) {
    if (err instanceof FrontmatterError) {
      return { ok: false, reason: "invalid-frontmatter", error: err.message };
    }
    throw err;
  }
}

/**
 * Normalize the `tools` frontmatter field.
 *
 * Accepts:
 *   - `string[]`       — passed through (non-string entries dropped)
 *   - comma-string     — split on `,` and trimmed (Claude users write both)
 *   - anything else    — returns undefined (lenient drop, NOT an error)
 *
 * Strips `(...)` permission patterns: `"Bash(npm:*)"` → `"Bash"` (v1 has no
 * per-argument permissions; the pattern is meaningless to us, so we treat the
 * spec as the bare tool name).
 *
 * Empty strings are filtered out. An empty result returns `[]` (treated as
 * "no tools" by the spawn-time resolver — distinct from `undefined` which
 * means "wildcard").
 */
export function normalizeTools(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  let arr: string[];
  if (Array.isArray(v)) {
    arr = v.filter((x): x is string => typeof x === "string");
  } else if (typeof v === "string") {
    arr = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return undefined;
  }
  return arr.map((t) => t.split("(")[0]!.trim()).filter(Boolean);
}
