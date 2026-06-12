import { describe, expect, it } from "bun:test";
import path from "node:path";
import { loadSkillsFromDir } from "./loader.js";

const FIXTURES = path.resolve(import.meta.dir, "..", "..", "tests", "fixtures", "skills");
const BUILTINS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

async function load(name: string) {
  return loadSkillsFromDir({
    configDir: path.join(FIXTURES, name),
    builtinToolNames: BUILTINS,
  });
}

describe("loadSkillsFromDir", () => {
  it("loads a skill with the full frontmatter field set", async () => {
    const { skills, skipped } = await load("valid-full");
    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.name).toBe("full-skill");
    expect(s.frontmatter.description).toBe("A skill exercising every supported frontmatter field.");
    expect(s.frontmatter.whenToUse).toBe("When testing the full frontmatter schema.");
    expect(s.frontmatter.allowedTools).toEqual(["Read", "Bash"]);
    expect(s.frontmatter.arguments).toEqual(["target", "mode"]);
    expect(s.frontmatter.argumentHint).toBe("<target> <mode>");
    expect(s.frontmatter.model).toBe("claude-sonnet-4-6");
    expect(s.frontmatter.version).toBe("1.2.3");
    expect(s.frontmatter.disableModelInvocation).toBe(false);
    expect(s.body).toContain("Hello from the full skill");
    expect(path.isAbsolute(s.dir)).toBe(true);
  });

  it("loads a minimal skill with only a description", async () => {
    const { skills, skipped } = await load("valid-min");
    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("min-skill");
    expect(skills[0]!.frontmatter.disableModelInvocation).toBe(false);
    expect(skills[0]!.body.trim()).toBe("Body of the minimal skill.");
  });

  it("skips a skill missing description", async () => {
    const { skills, skipped } = await load("missing-desc");
    expect(skills).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("invalid-frontmatter");
    expect(skipped[0]!.detail).toContain("description");
  });

  it("skips a skill with malformed YAML", async () => {
    const { skills, skipped } = await load("bad-yaml");
    expect(skills).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("invalid-frontmatter");
    expect(skipped[0]!.detail).toContain("YAML parse error");
  });

  it("loads a skill with unknown frontmatter keys, ignoring them", async () => {
    const { skills, skipped } = await load("unknown-key");
    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("bad");
    expect(skills[0]!.frontmatter.description).toBe("Skill with an unknown frontmatter field.");
  });

  it("returns empty when the skills/ directory does not exist", async () => {
    const { skills, skipped } = await load("does-not-exist");
    expect(skills).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("skips a directory that has no SKILL.md", async () => {
    // Build an ad-hoc fixture in-memory by pointing at a path that exists but
    // contains an entry without SKILL.md.
    const { skills, skipped } = await loadSkillsFromDir({
      configDir: path.join(FIXTURES, "valid-full"),
      builtinToolNames: BUILTINS,
    });
    expect(skills).toHaveLength(1);
    expect(skipped).toEqual([]);
    // Now point at a fixture that omits SKILL.md
    const empty = await loadSkillsFromDir({
      configDir: path.join(FIXTURES, "no-skill-md"),
      builtinToolNames: BUILTINS,
    });
    expect(empty.skills).toEqual([]);
    expect(empty.skipped).toHaveLength(1);
    expect(empty.skipped[0]!.reason).toBe("missing-skill-md");
  });

  it("skips a skill whose name collides with a builtin tool", async () => {
    const { skills, skipped } = await load("tool-collision");
    expect(skills).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision-tool");
  });

  it("skips a second skill that uses an already-loaded name", async () => {
    const { skills, skipped } = await load("skill-collision");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("twin");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision-skill");
  });

  it("normalizes skill names to lowercase and dedupes case-insensitively", async () => {
    const { skills, skipped } = await load("case-name");
    // 'UpperName' loads as 'uppername'; 'Dup' and 'dup' collide post-normalization.
    expect(skills.map((s) => s.name).sort()).toEqual(["dup", "uppername"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision-skill");
  });

  it("allows an empty body", async () => {
    const { skills, skipped } = await load("empty-body");
    expect(skipped).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe("");
  });

  it("returns skills sorted by name regardless of fs traversal order", async () => {
    const a = await load("sort-order");
    const b = await load("sort-order");
    expect(a.skills.map(s => s.name)).toEqual(["alpha", "mango", "zeta"]);
    expect(a.skills.map(s => s.name)).toEqual(b.skills.map(s => s.name));
  });

  it("rejects arguments slot named ARGUMENTS", async () => {
    const tmp = path.join(FIXTURES, "arg-reserved");
    const dir = path.join(tmp, "skills", "bad");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\ndescription: bad arg\narguments:\n  - ARGUMENTS\n---\n\nBody.\n",
    );
    try {
      const { skills, skipped } = await loadSkillsFromDir({
        configDir: tmp,
        builtinToolNames: BUILTINS,
      });
      expect(skills).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.detail).toContain("ARGUMENTS");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
