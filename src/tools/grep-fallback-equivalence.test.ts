/**
 * Equivalence tests: assert that the JS fallback produces the same output as rg
 * for a fixture corpus on the common flag combinations.
 *
 * All scenarios use it.skipIf(!hasRg) so the file stays green when rg is absent.
 *
 * Strategy per scenario:
 *   1. Run rg via runRipgrep, strip the absolute fixtureDir prefix → relative paths.
 *   2. Run runGrepFallback directly (same code GrepTool uses when rg is absent).
 *   3. Sort both sides to eliminate traversal-order differences.
 *   4. Assert equality (or set-equality for context-line scenarios).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runRipgrep } from "./_helpers.js";
import { runGrepFallback } from "./grep-fallback.js";
import { GrepTool } from "./grep.js";
import type { GrepInput } from "./grep.js";

// ---------------------------------------------------------------------------
// rg availability check (bypasses module cache)
// ---------------------------------------------------------------------------

function detectRg(): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    try {
      fs.accessSync(path.join(dir, "rg"), fs.constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

const hasRg = detectRg();

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

let fixtureDir: string;

const CORPUS: Record<string, string> = {
  "src/foo.ts": [
    "export const foo = 1;",
    "// TODO: remove this",
    "export function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "// NOTE: this is fine",
    "export const bar = foo + 2;",
  ].join("\n"),
  "src/bar.ts": [
    "import { foo } from './foo';",
    "export const baz = foo * 2;",
    "// TODO: write tests",
    "export default baz;",
  ].join("\n"),
  "src/util.js": [
    "function util() { return 42; }",
    "module.exports = { util };",
  ].join("\n"),
  "docs/readme.md": [
    "# Project",
    "This project exports foo and bar.",
    "TODO: add more docs",
  ].join("\n"),
  "docs/notes.md": [
    "## Notes",
    "Some notes about the project.",
    "See src/ for implementation.",
  ].join("\n"),
  "src/arrow.ts": [
    "const f = () => 1;",
    "// pointer->field access",
    "run --flag value",
  ].join("\n"),
};

beforeAll(async () => {
  fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skawld-grep-equiv-"));
  for (const [rel, content] of Object.entries(CORPUS)) {
    const abs = path.join(fixtureDir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, "utf8");
  }
});

afterAll(async () => {
  await fs.promises.rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tool = new GrepTool();

/** Build the rg arg array from a GrepInput (mirrors GrepTool.buildRgArgs). */
function buildRgArgs(input: GrepInput, searchRoot: string): string[] {
  const args: string[] = ["--max-columns", "500"];
  const mode = input.output_mode ?? "files_with_matches";
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count")         args.push("--count");
  if (input["-i"])      args.push("--ignore-case");
  if (input["-n"] && mode === "content") args.push("--line-number");
  if (input.multiline)  args.push("--multiline", "--multiline-dotall");
  const ctxC = input["-C"];
  if (ctxC !== undefined) {
    args.push("-C", String(ctxC));
  } else {
    if (input["-A"] !== undefined) args.push("-A", String(input["-A"]));
    if (input["-B"] !== undefined) args.push("-B", String(input["-B"]));
  }
  if (input.glob) args.push("--glob", input.glob);
  if (input.type) args.push("--type", input.type);
  // Pass the pattern via -e so leading-dash patterns aren't parsed as flags.
  args.push("-e", input.pattern, searchRoot);
  return args;
}

type ScenarioArgs = Omit<Partial<GrepInput>, "pattern" | "path">;

/**
 * Run the rg primary path. Returns sorted, path-normalized lines
 * (absolute fixtureDir prefix stripped → relative paths, matching fallback output).
 */
async function rgLines(pattern: string, args: ScenarioArgs = {}): Promise<string[]> {
  const input = tool.validate({ pattern, path: fixtureDir, ...args });
  const result = await runRipgrep(buildRgArgs(input, fixtureDir), fixtureDir);
  if (result.noMatches) return [];
  const prefix = fixtureDir + path.sep;
  return result.output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
    .sort();
}

/**
 * Run the JS fallback directly. Returns sorted lines.
 */
async function fbLines(pattern: string, args: ScenarioArgs = {}): Promise<string[]> {
  const input = tool.validate({ pattern, path: fixtureDir, ...args });
  const raw = await runGrepFallback(input, fixtureDir);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).sort();
}

/** Strip "--" separator lines (used when comparing context-line output cross-impl). */
function stripSep(lines: string[]): string[] {
  return lines.filter((l) => l !== "--");
}

// ---------------------------------------------------------------------------
// Equivalence scenarios
// ---------------------------------------------------------------------------

describe("Grep fallback equivalence", () => {
  it.skipIf(!hasRg)("S1: plain pattern, files_with_matches", async () => {
    expect(await fbLines("TODO")).toEqual(await rgLines("TODO"));
  });

  it.skipIf(!hasRg)("S2: plain pattern, count mode", async () => {
    expect(await fbLines("TODO", { output_mode: "count" }))
      .toEqual(await rgLines("TODO", { output_mode: "count" }));
  });

  it.skipIf(!hasRg)("S3: -i case-insensitive, files_with_matches", async () => {
    expect(await fbLines("todo", { "-i": true }))
      .toEqual(await rgLines("todo", { "-i": true }));
  });

  it.skipIf(!hasRg)("S4: content mode, no flags", async () => {
    expect(await fbLines("TODO", { output_mode: "content" }))
      .toEqual(await rgLines("TODO", { output_mode: "content" }));
  });

  it.skipIf(!hasRg)("S5: content mode with -n line numbers", async () => {
    expect(await fbLines("TODO", { output_mode: "content", "-n": true }))
      .toEqual(await rgLines("TODO", { output_mode: "content", "-n": true }));
  });

  it.skipIf(!hasRg)("S6: glob filter **/*.ts, files_with_matches", async () => {
    expect(await fbLines("export", { glob: "**/*.ts" }))
      .toEqual(await rgLines("export", { glob: "**/*.ts" }));
  });

  it.skipIf(!hasRg)("S7: glob filter **/*.md, files_with_matches", async () => {
    expect(await fbLines("TODO", { glob: "**/*.md" }))
      .toEqual(await rgLines("TODO", { glob: "**/*.md" }));
  });

  it.skipIf(!hasRg)("S8: zero matches returns empty", async () => {
    expect(await fbLines("ZZZNOMATCH_XYZ")).toEqual([]);
    expect(await rgLines("ZZZNOMATCH_XYZ")).toEqual([]);
  });

  it.skipIf(!hasRg)("S9: -i + content mode", async () => {
    expect(await fbLines("todo", { "-i": true, output_mode: "content" }))
      .toEqual(await rgLines("todo", { "-i": true, output_mode: "content" }));
  });

  it.skipIf(!hasRg)("S10: count mode with -i", async () => {
    expect(await fbLines("todo", { "-i": true, output_mode: "count" }))
      .toEqual(await rgLines("todo", { "-i": true, output_mode: "count" }));
  });

  it.skipIf(!hasRg)("S11: pattern matching across multiple files", async () => {
    expect(await fbLines("foo", { output_mode: "files_with_matches" }))
      .toEqual(await rgLines("foo", { output_mode: "files_with_matches" }));
  });

  // S12: context lines (-C 1).
  // rg and the fallback may emit "--" separators at slightly different positions
  // when context groups from different matches are adjacent. We compare only
  // the non-separator lines (set equality).
  it.skipIf(!hasRg)("S12: content mode with -C 1 context (set equality, separators stripped)", async () => {
    const fb = stripSep(await fbLines("TODO", { output_mode: "content", "-n": true, "-C": 1 }));
    const rg = stripSep(await rgLines("TODO", { output_mode: "content", "-n": true, "-C": 1 }));
    expect(fb).toEqual(rg);
  });

  // E2: patterns beginning with '-' must work (passed via -e), matching the
  // fallback. Without -e, rg would reject "->" / "--flag" as unknown flags.
  it.skipIf(!hasRg)("S13: leading-dash pattern '->' (content)", async () => {
    expect(await fbLines("->", { output_mode: "content" }))
      .toEqual(await rgLines("->", { output_mode: "content" }));
  });

  it.skipIf(!hasRg)("S14: leading-dash pattern '--flag' (files_with_matches)", async () => {
    expect(await fbLines("--flag")).toEqual(await rgLines("--flag"));
  });

  // F2: multiline mode must match across newlines in the fallback too. A pattern
  // spanning the function signature and the next line only matches when the regex
  // runs against the whole file, not line-by-line.
  it.skipIf(!hasRg)("S15: multiline pattern across newline (files_with_matches)", async () => {
    const fb = await fbLines("add\\([^)]*\\)\\s*\\{\\s*\\n\\s*return", { multiline: true });
    const rg = await rgLines("add\\([^)]*\\)\\s*\\{\\s*\\n\\s*return", { multiline: true });
    expect(fb).toEqual(rg);
    expect(fb).toEqual(["src/foo.ts"]);
  });

  // F3: an invalid regex is an error on both paths, not a match result. The rg
  // path exits non-zero (runRipgrep throws); the fallback throws too.
  it.skipIf(!hasRg)("S16: invalid regex errors on both paths", async () => {
    const input = tool.validate({ pattern: "[invalid", path: fixtureDir });
    let fbThrew = false;
    try {
      await runGrepFallback(input, fixtureDir);
    } catch {
      fbThrew = true;
    }
    expect(fbThrew).toBe(true);
    let rgThrew = false;
    try {
      await runRipgrep(buildRgArgs(input, fixtureDir), fixtureDir);
    } catch {
      rgThrew = true;
    }
    expect(rgThrew).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Glob fallback equivalence (F1, F4)
// ---------------------------------------------------------------------------

describe("Glob fallback equivalence", () => {
  // F4: a slash-less glob pattern must match at any depth in the fallback, the
  // same way rg's gitignore-style globs do.
  it.skipIf(!hasRg)("G-S1: slash-less '*.ts' matches at any depth", async () => {
    const rg = await runRipgrep(["--files", "--glob", "*.ts", "--glob", "!.*", fixtureDir], fixtureDir);
    const rgFiles = rg.noMatches
      ? []
      : rg.output
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter(Boolean)
          .map((f) => (path.isAbsolute(f) ? path.relative(fixtureDir, f) : f))
          .sort();
    const { runGlobFallbackForTest } = await import("./glob.js");
    const fb = (await runGlobFallbackForTest("*.ts", fixtureDir)).sort();
    expect(fb).toEqual(rgFiles);
    // sanity: the nested file is present
    expect(fb).toContain("src/foo.ts");
  });

  // F1: the fallback honors .gitignore like `rg --files` does.
  it.skipIf(!hasRg)("G-S2: fallback respects .gitignore", async () => {
    const giDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skawld-glob-equiv-"));
    try {
      await fs.promises.mkdir(path.join(giDir, "build"), { recursive: true });
      await fs.promises.writeFile(path.join(giDir, "keep.ts"), "x", "utf8");
      await fs.promises.writeFile(path.join(giDir, "build", "out.ts"), "x", "utf8");
      await fs.promises.writeFile(path.join(giDir, ".gitignore"), "build/\n", "utf8");
      const { runGlobFallbackForTest } = await import("./glob.js");
      const fb = (await runGlobFallbackForTest("*.ts", giDir)).sort();
      expect(fb).toEqual(["keep.ts"]);
    } finally {
      await fs.promises.rm(giDir, { recursive: true, force: true });
    }
  });
});
