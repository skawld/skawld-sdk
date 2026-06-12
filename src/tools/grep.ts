import type { Tool, ToolContext, ToolResult } from "./base.js";
import { findExecutable, resolvePath, runRipgrep, truncateOutput } from "./_helpers.js";
import { ToolExecutionError } from "../core/errors.js";
import { runGrepFallback } from "./grep-fallback.js";

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "files_with_matches" | "content" | "count";
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  multiline?: boolean;
  head_limit?: number;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    pattern:     { type: "string", description: "Regex pattern to search for." },
    path:        { type: "string", description: "Root directory to search. Defaults to working directory." },
    glob:        { type: "string", description: "File filter glob pattern, e.g. '**/*.ts'." },
    type:        { type: "string", description: "File type alias (e.g. 'ts', 'js', 'py'). Passed as rg --type." },
    output_mode: {
      type: "string",
      enum: ["files_with_matches", "content", "count"],
      description: "Output mode. Default: files_with_matches.",
    },
    "-i":        { type: "boolean", description: "Case-insensitive matching." },
    "-n":        { type: "boolean", description: "Show line numbers (content mode)." },
    "-A":        { type: "number",  description: "Lines of context after match." },
    "-B":        { type: "number",  description: "Lines of context before match." },
    "-C":        { type: "number",  description: "Lines of context before and after match." },
    multiline:   { type: "boolean", description: "Enable multiline mode (. matches newlines)." },
    head_limit:  { type: "number",  description: "Max output lines. Default 250." },
  },
  required: ["pattern"],
};

const OUTPUT_CAP = 30000;
const DEFAULT_HEAD_LIMIT = 250;

function buildRgArgs(input: GrepInput, searchRoot: string): string[] {
  const args: string[] = ["--max-columns", "500"];
  const mode = input.output_mode ?? "files_with_matches";

  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count")         args.push("--count");
  // content mode = default rg output

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

  // Pass the pattern via -e so patterns beginning with '-' (e.g. "->", "--foo")
  // aren't parsed as rg flags. Always pass a target path — non-interactive rg
  // can block on stdin otherwise.
  args.push("-e", input.pattern, searchRoot);
  return args;
}

export class GrepTool implements Tool<GrepInput> {
  readonly name = "Grep";
  readonly description =
    "Searches file contents by regex. Uses ripgrep when available; falls back to a pure-JS implementation. " +
    "Output modes: files_with_matches (default), content, count. " +
    "Supports -i, -n, -A/-B/-C context, multiline, glob filter, type filter.";
  readonly input_schema = SCHEMA;
  readonly scope = "read" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): GrepInput {
    if (typeof raw.pattern !== "string" || raw.pattern === "") {
      throw new ToolExecutionError("pattern is required and must be a non-empty string", {
        tool_name: this.name,
      });
    }
    const coerceNum = (v: unknown, field: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new ToolExecutionError(`${field} must be a non-negative number`, { tool_name: this.name });
      }
      return Math.floor(n);
    };
    const validModes = ["files_with_matches", "content", "count"];
    if (raw.output_mode !== undefined && !validModes.includes(raw.output_mode as string)) {
      throw new ToolExecutionError(`output_mode must be one of: ${validModes.join(", ")}`, {
        tool_name: this.name,
      });
    }
    return {
      pattern:     raw.pattern,
      path:        raw.path        as string | undefined,
      glob:        raw.glob        as string | undefined,
      type:        raw.type        as string | undefined,
      output_mode: raw.output_mode as GrepInput["output_mode"],
      "-i":        raw["-i"]       as boolean | undefined,
      "-n":        raw["-n"]       as boolean | undefined,
      "-A":        coerceNum(raw["-A"],       "-A"),
      "-B":        coerceNum(raw["-B"],       "-B"),
      "-C":        coerceNum(raw["-C"],       "-C"),
      multiline:   raw.multiline   as boolean | undefined,
      head_limit:  coerceNum(raw.head_limit, "head_limit"),
    };
  }

  summarize(input: GrepInput): string {
    const mode = input.output_mode ?? "files_with_matches";
    return `Grep ${JSON.stringify(input.pattern)} (${mode})${input.path ? ` in ${input.path}` : ""}`;
  }

  async execute(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
    const rootRaw = input.path ?? "";
    const searchRoot = rootRaw ? resolvePath(rootRaw, ctx.cwd) : ctx.cwd;
    const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;

    let rawOutput: string;
    try {
      if (findExecutable("rg")) {
        const result = await runRipgrep(buildRgArgs(input, searchRoot), searchRoot, ctx.signal);
        rawOutput = result.noMatches ? "" : result.output;
      } else {
        rawOutput = await runGrepFallback(input, searchRoot);
      }
    } catch (err) {
      if ((err as Error).message?.includes("Aborted")) {
        return { content: "Grep search aborted.", summary: "aborted", is_error: true };
      }
      return { content: `Grep error: ${(err as Error).message}`, summary: "grep error", is_error: true };
    }

    if (!rawOutput || rawOutput.trim() === "") {
      return { content: "No matches found.", summary: "no matches" };
    }

    // Apply head_limit (global line cap — rg's --max-count is per-file only)
    const lines = rawOutput.split("\n");
    let limited = lines.slice(0, headLimit).join("\n");
    if (lines.length > headLimit) {
      limited += `\n… (truncated to ${headLimit} of ${lines.length} lines)`;
    }

    // Apply 30000-char combined output cap
    return {
      content: truncateOutput(limited, OUTPUT_CAP),
      summary: `Grep matched ${Math.min(lines.length, headLimit)} line(s)`,
    };
  }
}
