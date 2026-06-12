import { describe, expect, it } from "bun:test";
import { substituteSkillBody } from "./substitute.js";
import type { Skill } from "./types.js";

function mkSkill(body: string, args?: string[]): Skill {
  return {
    name: "s",
    dir: "/abs/path/to/s",
    frontmatter: {
      name: "s",
      description: "d",
      disableModelInvocation: false,
      ...(args ? { arguments: args } : {}),
    },
    body,
  };
}

describe("substituteSkillBody", () => {
  it("substitutes a single named arg", () => {
    const out = substituteSkillBody({
      skill: mkSkill("hello $name", ["name"]),
      args: "world",
      sessionId: "sid",
    });
    expect(out).toBe("Skill base directory: /abs/path/to/s\n\nhello world");
  });

  it("substitutes multiple named args", () => {
    const out = substituteSkillBody({
      skill: mkSkill("$a + $b = ?", ["a", "b"]),
      args: "1 2",
      sessionId: "sid",
    });
    expect(out).toContain("1 + 2 = ?");
  });

  it("missing args become empty strings", () => {
    const out = substituteSkillBody({
      skill: mkSkill("$a-$b", ["a", "b"]),
      args: "only",
      sessionId: "sid",
    });
    expect(out).toContain("only-");
  });

  it("substitutes $ARGUMENTS with the raw args string", () => {
    const out = substituteSkillBody({
      skill: mkSkill("got: $ARGUMENTS"),
      args: 'a "b c"',
      sessionId: "sid",
    });
    expect(out).toContain('got: a "b c"');
  });

  it("substitutes ${SKAWLD_SKILL_DIR} and ${SKAWLD_SESSION_ID}", () => {
    const out = substituteSkillBody({
      skill: mkSkill("dir=${SKAWLD_SKILL_DIR} sid=${SKAWLD_SESSION_ID}"),
      args: "",
      sessionId: "abc-123",
    });
    expect(out).toContain("dir=/abs/path/to/s sid=abc-123");
  });

  it("body without substitutables gets just the header", () => {
    const out = substituteSkillBody({
      skill: mkSkill("plain body"),
      args: "",
      sessionId: "sid",
    });
    expect(out).toBe("Skill base directory: /abs/path/to/s\n\nplain body");
  });

  it("always prepends the base-dir header", () => {
    const out = substituteSkillBody({
      skill: mkSkill(""),
      args: "",
      sessionId: "sid",
    });
    expect(out.startsWith("Skill base directory: /abs/path/to/s\n\n")).toBe(true);
  });

  it("is byte-identical across two calls with the same input", () => {
    const skill = mkSkill("hi $name dir=${SKAWLD_SKILL_DIR}", ["name"]);
    const a = substituteSkillBody({ skill, args: "you", sessionId: "sid" });
    const b = substituteSkillBody({ skill, args: "you", sessionId: "sid" });
    expect(a).toBe(b);
  });

  // --- single-pass guarantees (no replacement is re-scanned) ---

  it("does not let one slot clobber the prefix of another (single-pass)", () => {
    // $file substituted first must not break $filename: both resolve independently.
    const out = substituteSkillBody({
      skill: mkSkill("open $filename with $file", ["file", "filename"]),
      args: "vim notes.txt",
      sessionId: "sid",
    });
    expect(out).toContain("open notes.txt with vim");
  });

  it("treats argument values as literals, not templates (no re-expansion)", () => {
    // A value containing $b is inserted verbatim, not rewritten by the $b slot pass.
    const out = substituteSkillBody({
      skill: mkSkill("$a / $b", ["a", "b"]),
      args: '"$b" second',
      sessionId: "sid",
    });
    expect(out).toContain("$b / second");
  });

  it("inserts $ARGUMENTS in an argument value verbatim", () => {
    const out = substituteSkillBody({
      skill: mkSkill("[$a]", ["a"]),
      args: '"$ARGUMENTS"',
      sessionId: "sid",
    });
    expect(out).toContain("[$ARGUMENTS]");
  });

  it("does not let a slot prefix eat $ARGUMENTS (reserved consumed whole)", () => {
    // A slot named ARGUMENT must not chew into $ARGUMENTS in the body.
    const out = substituteSkillBody({
      skill: mkSkill("slot=$ARGUMENT reserved=$ARGUMENTS", ["ARGUMENT"]),
      args: "X",
      sessionId: "sid",
    });
    expect(out).toContain("slot=X reserved=X");
  });

  it("leaves an unknown $name untouched", () => {
    const out = substituteSkillBody({
      skill: mkSkill("keep $unknown here", ["name"]),
      args: "world",
      sessionId: "sid",
    });
    expect(out).toContain("keep $unknown here");
  });
});
