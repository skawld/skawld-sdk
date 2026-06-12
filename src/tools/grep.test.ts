import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GrepTool } from "./grep.js";
import type { ToolContext } from "./base.js";
import { FileReadTracker } from "./file-tracker.js";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let fixtureDir: string;

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    fileReadTracker: new FileReadTracker(),
    sessionId: "test-session",
    runId: "test-run",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStore: null as any,
  };
}

const FIXTURE_FILES: Record<string, string> = {
  "src/alpha.ts": [
    "export const alpha = 1;",
    "// TODO: refactor this",
    "export function greet(name: string) {",
    "  return `Hello, ${name}!`;",
    "}",
  ].join("\n"),
  "src/beta.ts": [
    "import { alpha } from './alpha';",
    "export const beta = alpha + 1;",
    "// TODO: add tests",
  ].join("\n"),
  "src/gamma.js": [
    "const gamma = 3;",
    "module.exports = { gamma };",
  ].join("\n"),
  "docs/notes.md": [
    "# Notes",
    "This project uses TODO markers extensively.",
    "See src/ for details.",
  ].join("\n"),
  "binary.bin": "\x00\x01\x02\x03binary content",
};

beforeAll(async () => {
  fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skawld-grep-"));
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(fixtureDir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, "utf8");
  }
  // Write a .gitignore that excludes docs/
  await fs.promises.writeFile(path.join(fixtureDir, ".gitignore"), "docs/\n", "utf8");
});

afterAll(async () => {
  await fs.promises.rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tool = new GrepTool();

describe("GrepTool — validate", () => {
  it("accepts minimal valid input", () => {
    const input = tool.validate({ pattern: "TODO" });
    expect(input.pattern).toBe("TODO");
    expect(input.output_mode).toBeUndefined();
    expect(input.head_limit).toBeUndefined();
  });

  it("throws on missing pattern", () => {
    expect(() => tool.validate({})).toThrow();
  });

  it("throws on empty pattern", () => {
    expect(() => tool.validate({ pattern: "" })).toThrow();
  });

  it("throws on invalid output_mode", () => {
    expect(() => tool.validate({ pattern: "x", output_mode: "bad" })).toThrow();
  });

  it("throws on negative -A", () => {
    expect(() => tool.validate({ pattern: "x", "-A": -1 })).toThrow();
  });

  it("coerces numeric strings for head_limit", () => {
    const input = tool.validate({ pattern: "x", head_limit: "10" });
    expect(input.head_limit).toBe(10);
  });
});

describe("GrepTool — execute, files_with_matches (default)", () => {
  it("returns files containing pattern", async () => {
    const input = tool.validate({ pattern: "TODO", path: fixtureDir });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    expect(result.is_error).toBeUndefined();
    const content = result.content as string;
    expect(content).toContain("alpha.ts");
    expect(content).toContain("beta.ts");
    // gamma.js has no TODO
    expect(content).not.toContain("gamma.js");
  });

  it("returns 'No matches found.' when nothing matches", async () => {
    const input = tool.validate({ pattern: "ZZZNOMATCH", path: fixtureDir });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("No matches found.");
  });

  it("does not return binary files", async () => {
    const input = tool.validate({ pattern: "binary", path: fixtureDir });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    expect(content).not.toContain("binary.bin");
  });
});

describe("GrepTool — execute, content mode", () => {
  it("returns matching lines with file path prefix", async () => {
    const input = tool.validate({ pattern: "TODO", path: fixtureDir, output_mode: "content" });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    expect(result.is_error).toBeUndefined();
    const content = result.content as string;
    expect(content).toContain("TODO");
    // Each line should be prefixed with a file path
    const lines = content.split("\n").filter(Boolean);
    expect(lines.every((l) => l.includes(":"))).toBe(true);
  });

  it("-i flag makes search case-insensitive", async () => {
    const input = tool.validate({
      pattern: "todo",
      path: fixtureDir,
      output_mode: "content",
      "-i": true,
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    expect(content).toContain("TODO");
  });

  it("-n flag includes line numbers", async () => {
    const input = tool.validate({
      pattern: "TODO",
      path: fixtureDir,
      output_mode: "content",
      "-n": true,
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    // Expect path:lineNo:text format
    const lines = content.split("\n").filter(Boolean);
    // At least one line should have the pattern path:N:text
    expect(lines.some((l) => /:\d+:/.test(l))).toBe(true);
  });

  it("-C context lines includes surrounding lines and -- separator", async () => {
    const input = tool.validate({
      pattern: "TODO",
      path: fixtureDir,
      output_mode: "content",
      "-n": true,
      "-C": 1,
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    // Should contain lines beyond just the matching line
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(2);
  });
});

describe("GrepTool — execute, count mode", () => {
  it("returns path:count format", async () => {
    const input = tool.validate({ pattern: "TODO", path: fixtureDir, output_mode: "count" });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    expect(result.is_error).toBeUndefined();
    const content = result.content as string;
    const lines = content.split("\n").filter(Boolean);
    // Each line should be path:N
    expect(lines.every((l) => /:\d+$/.test(l))).toBe(true);
    // alpha.ts has 1 TODO
    const alphaLine = lines.find((l) => l.includes("alpha.ts"));
    expect(alphaLine).toBeDefined();
    expect(alphaLine).toMatch(/:1$/);
  });
});

describe("GrepTool — glob filter", () => {
  it("glob filter restricts to matching files", async () => {
    const input = tool.validate({
      pattern: "TODO",
      path: fixtureDir,
      glob: "**/*.ts",
      output_mode: "files_with_matches",
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    expect(content).toContain(".ts");
    expect(content).not.toContain(".js");
    expect(content).not.toContain(".md");
  });
});

describe("GrepTool — head_limit", () => {
  it("truncates output to head_limit lines", async () => {
    // Create a file with many matching lines
    const manyLinesPath = path.join(fixtureDir, "many.txt");
    const lines = Array.from({ length: 300 }, (_, i) => `MATCH line ${i + 1}`).join("\n");
    await fs.promises.writeFile(manyLinesPath, lines, "utf8");

    const input = tool.validate({
      pattern: "MATCH",
      path: fixtureDir,
      output_mode: "content",
      head_limit: 50,
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const content = result.content as string;
    const outputLines = content.split("\n");
    // First 50 match lines + 1 truncation marker
    expect(outputLines.length).toBeLessThanOrEqual(52);
    expect(content).toContain("truncated");

    await fs.promises.unlink(manyLinesPath).catch(() => {});
  });
});

describe("GrepTool — output cap at 30000 chars", () => {
  it("truncates at 30000 chars with marker", async () => {
    // Write a file with many short matching lines. Each output line will be
    // prefixed with the path, so total chars per line ≈ 80 (path) + 40 (text) = ~120.
    // 400 lines × ~120 chars = ~48000 chars → exceeds the 30000-char cap.
    const bigPath = path.join(fixtureDir, "big.txt");
    // Use a fixed-width match line so the total is deterministic
    const matchLine = "CAPTEST " + "y".repeat(100); // ~108 chars of content
    const fileContent = Array.from({ length: 400 }, () => matchLine).join("\n");
    await fs.promises.writeFile(bigPath, fileContent, "utf8");

    const input = tool.validate({
      pattern: "CAPTEST",
      path: fixtureDir,
      output_mode: "content",
      head_limit: 5000, // head_limit high enough to not kick in first
    });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    const out = result.content as string;
    expect(out.length).toBeLessThanOrEqual(30200); // 30000 cap + small marker overhead
    expect(out).toContain("truncated");

    await fs.promises.unlink(bigPath).catch(() => {});
  });
});

describe("GrepTool — summarize", () => {
  it("returns readable summary", () => {
    const input = tool.validate({ pattern: "foo", output_mode: "content" });
    expect(tool.summarize(input)).toContain("foo");
    expect(tool.summarize(input)).toContain("content");
  });
});

describe("GrepTool — invalid regex", () => {
  it("returns an error result for a bad regex pattern (both paths)", async () => {
    const input = tool.validate({ pattern: "[invalid" });
    const result = await tool.execute(input, makeCtx(fixtureDir));
    // Both the rg path (exit 2) and the fallback (throw) surface this as an error
    // result, not as successful match content.
    expect(result.is_error).toBe(true);
    expect(typeof result.content).toBe("string");
  });
});
