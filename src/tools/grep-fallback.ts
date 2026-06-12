/**
 * Pure-JS fallback for GrepTool, used when ripgrep is not on PATH.
 * Produces output that mirrors rg's output shapes for the common flag combinations.
 */

import fs from "node:fs";
import path from "node:path";
import fastGlob from "fast-glob";
import ignore from "ignore";
import type { GrepInput } from "./grep.js";

// ---------------------------------------------------------------------------
// .gitignore loading
// ---------------------------------------------------------------------------

/** Walk from root upward, loading each .gitignore found into an ignore instance. */
export async function loadGitignoreMatcher(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  let dir = root;
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    const giPath = path.join(dir, ".gitignore");
    try {
      const content = await fs.promises.readFile(giPath, "utf8");
      ig.add(content);
    } catch {
      // no .gitignore here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ig;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Type → glob mapping
// ---------------------------------------------------------------------------

export const TYPE_GLOBS: Record<string, string> = {
  ts: "**/*.{ts,tsx}",
  js: "**/*.{js,jsx,mjs,cjs}",
  py: "**/*.py",
  go: "**/*.go",
  rs: "**/*.rs",
  md: "**/*.{md,markdown}",
  json: "**/*.json",
  yaml: "**/*.{yaml,yml}",
  html: "**/*.{html,htm}",
  css: "**/*.css",
  sh: "**/*.sh",
  c: "**/*.{c,h}",
  cpp: "**/*.{cpp,cc,cxx,hpp,hxx}",
  java: "**/*.java",
  rb: "**/*.rb",
  php: "**/*.php",
  swift: "**/*.swift",
  kt: "**/*.kt",
};

// ---------------------------------------------------------------------------
// Per-file matching
// ---------------------------------------------------------------------------

interface MatchLine {
  lineNo: number; // 1-indexed
  text: string;
}

interface FileMatches {
  relPath: string;
  matches: MatchLine[];
  /** The file's lines, kept so content mode doesn't re-read the file. */
  lines: string[];
}

/** Largest 1-indexed line number whose start offset is ≤ `offset`. Binary search. */
function lineNoForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

async function grepFile(
  absPath: string,
  relPath: string,
  re: RegExp,
  multiline: boolean,
): Promise<FileMatches | null> {
  const buf = await fs.promises.readFile(absPath).catch(() => null);
  if (!buf || isBinary(buf)) return null;
  const text = buf.toString("utf8");
  const lines = text.split("\n");

  if (multiline) {
    // Match the whole file so patterns spanning newlines (or relying on dotall
    // across lines) match; report the line each match begins on.
    const lineStarts = [0];
    for (let i = 0; i < lines.length - 1; i++) {
      lineStarts.push(lineStarts[i]! + lines[i]!.length + 1);
    }
    const matches: MatchLine[] = [];
    const seen = new Set<number>();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const lineNo = lineNoForOffset(lineStarts, m.index);
      if (!seen.has(lineNo)) {
        seen.add(lineNo);
        matches.push({ lineNo, text: lines[lineNo - 1] ?? "" });
      }
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width matches
    }
    matches.sort((a, b) => a.lineNo - b.lineNo);
    return matches.length > 0 ? { relPath, matches, lines } : null;
  }

  const matches: MatchLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    re.lastIndex = 0;
    if (re.test(line)) matches.push({ lineNo: i + 1, text: line });
  }
  return matches.length > 0 ? { relPath, matches, lines } : null;
}

// ---------------------------------------------------------------------------
// Output renderers
// ---------------------------------------------------------------------------

function renderFilesWithMatches(results: FileMatches[]): string {
  return results.map((r) => r.relPath).join("\n");
}

function renderCount(results: FileMatches[]): string {
  return results.map((r) => `${r.relPath}:${r.matches.length}`).join("\n");
}

function renderContent(results: FileMatches[], input: GrepInput, fileLines: Map<string, string[]>): string {
  const ctxC = input["-C"];
  const ctxA = ctxC !== undefined ? ctxC : (input["-A"] ?? 0);
  const ctxB = ctxC !== undefined ? ctxC : (input["-B"] ?? 0);
  const showLineNo = input["-n"] ?? false;
  const out: string[] = [];

  for (const r of results) {
    const fc = fileLines.get(r.relPath) ?? [];
    type Range = { start: number; end: number };
    const ranges: Range[] = [];
    for (const m of r.matches) {
      const start = Math.max(0, m.lineNo - 1 - ctxB);
      const end = Math.min(fc.length - 1, m.lineNo - 1 + ctxA);
      const last = ranges[ranges.length - 1];
      if (last !== undefined && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }
    let prevEnd = -1;
    for (const range of ranges) {
      if (prevEnd >= 0 && range.start > prevEnd + 1) out.push("--");
      for (let i = range.start; i <= range.end; i++) {
        const lineText = fc[i] ?? "";
        const isMatch = r.matches.some((m) => m.lineNo === i + 1);
        if (showLineNo) {
          const sep = isMatch ? ":" : "-";
          out.push(`${r.relPath}${sep}${i + 1}${sep}${lineText}`);
        } else {
          out.push(`${r.relPath}:${lineText}`);
        }
      }
      prevEnd = range.end;
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main fallback entry point
// ---------------------------------------------------------------------------

export async function runGrepFallback(input: GrepInput, searchRoot: string): Promise<string> {
  const mode = input.output_mode ?? "files_with_matches";
  const flags = (input["-i"] ? "i" : "") + (input.multiline ? "ms" : "") + "g";
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, flags);
  } catch (err) {
    // Surface as an error result (the rg path also fails on a bad pattern),
    // rather than returning the message as successful match content.
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }

  const ig = await loadGitignoreMatcher(searchRoot);

  let globPattern = input.glob ?? "**/*";
  if (input.type) {
    const typeGlob = TYPE_GLOBS[input.type];
    if (typeGlob) globPattern = input.glob ? `{${input.glob},${typeGlob}}` : typeGlob;
  }

  const allFiles = await fastGlob(globPattern, {
    cwd: searchRoot,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [".git/**", ".hg/**", ".svn/**"],
  });
  const files = allFiles.filter((f) => !ig.ignores(f));

  const results: FileMatches[] = [];
  const fileLines = new Map<string, string[]>();

  for (const relPath of files) {
    const absPath = path.join(searchRoot, relPath);
    const fm = await grepFile(absPath, relPath, re, input.multiline ?? false);
    if (fm) {
      results.push(fm);
      // Reuse the lines grepFile already read — no second read of the file.
      if (mode === "content") fileLines.set(relPath, fm.lines);
    }
  }

  if (results.length === 0) return "";

  switch (mode) {
    case "files_with_matches": return renderFilesWithMatches(results);
    case "count":              return renderCount(results);
    case "content":            return renderContent(results, input, fileLines);
  }
}
