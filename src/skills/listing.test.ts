import { describe, expect, it } from "bun:test";
import { buildSkillListing } from "./listing.js";
import type { Skill } from "./types.js";

function mkSkill(name: string, description: string, extras: Partial<Skill["frontmatter"]> = {}): Skill {
  return {
    name,
    dir: `/skills/${name}`,
    frontmatter: {
      name,
      description,
      disableModelInvocation: false,
      ...extras,
    },
    body: "",
  };
}

describe("buildSkillListing", () => {
  it("returns empty string when no skills", () => {
    expect(buildSkillListing({ skills: [] })).toBe("");
  });

  it("emits full lines when within budget", () => {
    const skills = [
      mkSkill("alpha", "first"),
      mkSkill("beta", "second", { whenToUse: "use beta" }),
      mkSkill("gamma", "third", { argumentHint: "<x>" }),
    ];
    const out = buildSkillListing({ skills });
    expect(out).toBe(
      "- alpha: first\n" +
      "- beta: second — use beta\n" +
      "- gamma: third (args: <x>)",
    );
  });

  it("collapses newlines in a block-scalar description to one line", () => {
    // A YAML block scalar keeps embedded newlines; they must not split the
    // one-line-per-skill listing (which could even fake extra catalog entries).
    const out = buildSkillListing({
      skills: [mkSkill("a", "line one\nline two\n  - fake entry")],
    });
    expect(out).toBe("- a: line one line two - fake entry");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("caps per-entry description at 250 chars with a trailing …", () => {
    const longDesc = "x".repeat(500);
    const out = buildSkillListing({ skills: [mkSkill("a", longDesc)] });
    expect(out).toMatch(/^- a: x+…$/);
    const desc = out.slice("- a: ".length);
    expect(desc.length).toBe(250);
    expect(desc.endsWith("…")).toBe(true);
  });

  it("equal-allocates and truncates when over budget", () => {
    const skills = [
      mkSkill("alpha", "x".repeat(120)),
      mkSkill("beta", "y".repeat(120)),
      mkSkill("gamma", "z".repeat(120)),
    ];
    // pick a budget that yields >=20 per-entry: overhead = 9+8+9 = 26, newlines = 2 → budget = 26+2+3*30 = 118 (~ tokens 118/(4*0.01)=2950)
    const out = buildSkillListing({ skills, contextWindowTokens: 2950 });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.endsWith("…")).toBe(true);
    }
  });

  it("falls back to names-only when per-entry budget is too tight", () => {
    const skills = [
      mkSkill("alpha", "x".repeat(120)),
      mkSkill("beta", "y".repeat(120)),
    ];
    // 100 chars total, way too tight: 5 tokens budget = 0.2 chars but with fallback 8000 too generous,
    // so use explicit small contextWindowTokens.
    const out = buildSkillListing({ skills, contextWindowTokens: 50 });
    expect(out).toBe("- alpha\n- beta");
  });

  it("omits skills with disableModelInvocation: true", () => {
    const skills = [
      mkSkill("public", "shown"),
      mkSkill("hidden", "secret", { disableModelInvocation: true }),
    ];
    const out = buildSkillListing({ skills });
    expect(out).toContain("public");
    expect(out).not.toContain("hidden");
  });

  it("sorts stably and is byte-identical across calls", () => {
    const skills = [
      mkSkill("zeta", "z"),
      mkSkill("alpha", "a"),
      mkSkill("mango", "m"),
    ];
    const a = buildSkillListing({ skills });
    const b = buildSkillListing({ skills });
    expect(a).toBe(b);
    expect(a.split("\n").map(l => l.split(":")[0])).toEqual([
      "- alpha", "- mango", "- zeta",
    ]);
  });

  it("uses the 8000-char fallback budget when contextWindowTokens omitted", () => {
    // Build skills with combined size around 9000 chars: fallback truncates.
    const skills: Skill[] = [];
    for (let i = 0; i < 50; i++) {
      skills.push(mkSkill(`s${i.toString().padStart(2, "0")}`, "d".repeat(240)));
    }
    const out = buildSkillListing({ skills });
    expect(out.length).toBeLessThanOrEqual(8000);
  });
});
