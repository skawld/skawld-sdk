/**
 * Multi-directory tests for loadSkillsFromDir.
 *
 * Fixtures are built in fresh tmp directories per test (mirroring the pattern in
 * subagents/loader.test.ts) so the suite is self-contained and does not depend
 * on the gitignored tests/fixtures/skills tree.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsFromDir } from "./loader.js";

const BUILTINS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skawld-skills-multidir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create `<root>/<dir>/skills/<name>/SKILL.md` with a minimal valid frontmatter. */
async function writeSkill(dir: string, name: string, description: string): Promise<string> {
  const skillDir = path.join(root, dir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\ndescription: ${description}\n---\n\nBody of ${name} from ${dir}.\n`,
  );
  return path.join(root, dir);
}

function load(configDir: string | string[]) {
  return loadSkillsFromDir({ configDir, builtinToolNames: BUILTINS });
}

describe("loadSkillsFromDir — multi-directory", () => {
  it("single string keeps loading unchanged (back-compat)", async () => {
    const dir = await writeSkill("solo", "alpha", "Alpha skill.");
    const { skills, skipped } = await load(dir);
    expect(skipped).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(path.isAbsolute(skills[0]!.dir)).toBe(true);
  });

  it("loads the union of disjoint skills from all directories, sorted", async () => {
    const a = await writeSkill("law", "zeta", "Zeta from law.");
    const b = await writeSkill("tech", "alpha", "Alpha from tech.");
    const { skills, skipped } = await load([a, b]);
    expect(skipped).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("is order-independent in content for disjoint names", async () => {
    const a = await writeSkill("law", "zeta", "Zeta from law.");
    const b = await writeSkill("tech", "alpha", "Alpha from tech.");
    const forward = await load([a, b]);
    const reverse = await load([b, a]);
    expect(forward.skills.map((s) => s.name)).toEqual(reverse.skills.map((s) => s.name));
  });

  it("first directory wins on name collision; later duplicate is skipped", async () => {
    const a = await writeSkill("law", "twin", "Twin from law.");
    const b = await writeSkill("tech", "twin", "Twin from tech.");
    const { skills, skipped } = await load([a, b]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("twin");
    // The kept copy is the first directory's.
    expect(skills[0]!.body).toContain("from law");
    expect(skills[0]!.dir.startsWith(a)).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision-skill");
    // The skipped entry points at the later directory's copy.
    expect(skipped[0]!.dir.startsWith(b)).toBe(true);
  });

  it("skips a missing directory silently and loads the rest", async () => {
    const a = await writeSkill("law", "alpha", "Alpha from law.");
    const b = await writeSkill("tech", "beta", "Beta from tech.");
    const missing = path.join(root, "does-not-exist");
    const { skills, skipped } = await load([a, missing, b]);
    expect(skipped).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("empty array loads nothing (default injection is the caller's job)", async () => {
    const { skills, skipped } = await load([]);
    expect(skills).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("single-dir io-error still surfaces as a skipped io-error (back-compat)", async () => {
    // Make `<dir>/skills` a FILE, not a directory → readdir throws ENOTDIR (an
    // io-error, distinct from the ENOENT missing-dir case which is skipped).
    const dir = path.join(root, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "skills"), "not a directory");
    const { skills, skipped } = await load(dir);
    expect(skills).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("io-error");
  });

  it("builtin-tool name collision still fires across directories", async () => {
    const a = await writeSkill("law", "alpha", "Alpha from law.");
    // "Bash" collides with a builtin tool name (compared case-insensitively).
    const b = await writeSkill("tech", "Bash", "Shadows a builtin tool.");
    const { skills, skipped } = await load([a, b]);
    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision-tool");
  });
});
