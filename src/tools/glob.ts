import fs from "node:fs";
import path from "node:path";
import fastGlob from "fast-glob";
import type { Tool, ToolContext, ToolResult } from "./base.js";
import { findExecutable, resolvePath, runRipgrep } from "./_helpers.js";
import { loadGitignoreMatcher } from "./grep-fallback.js";
import { ToolExecutionError } from "../core/errors.js";

export interface GlobInput {
  pattern: string;
  path?: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." },
    path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
  },
  required: ["pattern"],
};

const GLOB_CAP = 1000;
const VCS_IGNORE = [".git/**", ".hg/**", ".svn/**"];

/** Extract the static base prefix (everything before the first glob metachar). */
function staticBase(pattern: string): { base: string; rest: string } {
  // Find first glob metachar: * ? [ {
  const metaIdx = pattern.search(/[*?[{]/);
  if (metaIdx === -1) return { base: pattern, rest: "." };
  const dir = path.dirname(pattern.slice(0, metaIdx));
  const rest = pattern.slice(dir === "." ? 0 : dir.length + 1);
  return { base: dir, rest };
}

async function runGlobFallback(pattern: string, root: string): Promise<string[]> {
  // A slash-less pattern matches at any depth under rg's gitignore-glob semantics
  // (e.g. "*.ts" finds nested files); fast-glob would otherwise match only the top level.
  const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
  const entries = await fastGlob(effective, {
    cwd: root,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: VCS_IGNORE,
  });
  // rg --files honors .gitignore; mirror that so the fallback doesn't flood with ignored files.
  const ig = await loadGitignoreMatcher(root);
  return entries.filter((f) => !ig.ignores(f));
}

/** Test-only hook for the fallback path (the rg path is exercised in production). */
export const runGlobFallbackForTest = runGlobFallback;

async function sortByMtime(files: string[], root: string): Promise<string[]> {
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await fs.promises.lstat(path.join(root, f));
        return { f, mtime: s.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats.map((s) => s.f);
}

export class GlobTool implements Tool<GlobInput> {
  readonly name = "Glob";
  readonly description =
    "Finds files matching a glob pattern. Uses ripgrep for speed when available; falls back to fast-glob. " +
    "Results are sorted by modification time (most recent first) and capped at 1000.";
  readonly input_schema = SCHEMA;
  readonly scope = "read" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): GlobInput {
    if (typeof raw.pattern !== "string" || raw.pattern === "") {
      throw new ToolExecutionError("pattern is required and must be a non-empty string", {
        tool_name: this.name,
      });
    }
    if (raw.path !== undefined && typeof raw.path !== "string") {
      throw new ToolExecutionError("path must be a string", { tool_name: this.name });
    }
    return { pattern: raw.pattern, path: raw.path as string | undefined };
  }

  summarize(input: GlobInput): string {
    return `Glob ${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  }

  async execute(input: GlobInput, ctx: ToolContext): Promise<ToolResult> {
    const rootRaw = input.path ?? "";
    const root = rootRaw ? resolvePath(rootRaw, ctx.cwd) : ctx.cwd;

    let pattern = input.pattern;
    let searchRoot = root;

    // Handle absolute glob: extract static base prefix
    if (path.isAbsolute(pattern)) {
      const { base, rest } = staticBase(pattern);
      searchRoot = base;
      pattern = rest;
    }

    let files: string[];
    try {
      if (findExecutable("rg")) {
        // Pass the inclusion pattern first, then the negation — rg applies globs last-wins
        // so '!.*' after the pattern excludes dot-files, matching fast-glob dot:false behavior
        const result = await runRipgrep(
          ["--files", "--glob", pattern, "--glob", "!.*", searchRoot],
          searchRoot,
          ctx.signal,
        );
        if (result.noMatches || result.output.trim() === "") {
          files = [];
        } else {
          files = result.output
            .split("\n")
            .map((l) => l.replace(/\r$/, "")) // strip only CR; trimming would corrupt edge-whitespace names
            .filter(Boolean)
            .map((f) => (path.isAbsolute(f) ? path.relative(root, f) : f));
        }
      } else {
        files = await runGlobFallback(pattern, searchRoot);
        // If searchRoot differs from root, make paths relative to root
        if (searchRoot !== root) {
          files = files.map((f) => path.relative(root, path.join(searchRoot, f)));
        }
      }
    } catch (err) {
      if ((err as Error).message?.includes("Aborted")) {
        return { content: "Glob search aborted.", summary: "aborted", is_error: true };
      }
      return {
        content: `Glob error: ${(err as Error).message}`,
        summary: "glob error",
        is_error: true,
      };
    }

    if (files.length === 0) {
      return { content: "No matches found.", summary: "no matches" };
    }

    // Sort by mtime DESC (single pass)
    const sorted = await sortByMtime(files, root);

    const total = sorted.length;
    const capped = sorted.slice(0, GLOB_CAP);
    let output = capped.join("\n");
    if (total > GLOB_CAP) {
      output += `\n… (truncated to ${GLOB_CAP} of ${total} results)`;
    }

    return {
      content: output,
      summary: `${Math.min(total, GLOB_CAP)} file(s) matched`,
    };
  }
}
