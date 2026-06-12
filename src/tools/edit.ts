import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";
import { resolvePath, atomicWriteFile } from "./_helpers.js";

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" },
    old_string: {
      type: "string",
      description: "Exact string to find. Must be unique unless replace_all is true. Do not include the cat -n line-number prefix.",
    },
    new_string: { type: "string", description: "String to replace it with." },
    replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
  },
  required: ["file_path", "old_string", "new_string"],
};

const MAX_EDIT_SIZE = 100 * 1024 * 1024; // 100 MiB

/**
 * Detect dominant line ending in the first 16 KiB.
 * Returns "\r\n" if CRLF outnumbers bare LF, otherwise "\n".
 */
function detectLineEnding(sample: string): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === "\r" && sample[i + 1] === "\n") { crlf++; i++; }
    else if (sample[i] === "\n") { lf++; }
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Count occurrences of needle and locate the first, in one indexOf pass —
 * no whole-file split allocation, and the single-edit path reuses firstIndex.
 */
function locateOccurrences(haystack: string, needle: string): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    if (firstIndex === -1) firstIndex = idx;
    count++;
    from = idx + needle.length;
  }
  return { count, firstIndex };
}

export class EditTool implements Tool<EditInput> {
  readonly name = "Edit";
  readonly description =
    "Performs an exact string replacement in a file. You must Read the file at least " +
    "once in this session before editing. The 'old_string' must appear exactly once " +
    "in the file unless 'replace_all' is true. Preserve indentation when matching. " +
    "Do not include the cat -n line-number prefix in old_string.";
  readonly input_schema = SCHEMA;
  readonly scope = "write" as const;
  readonly parallelSafe = false;

  validate(raw: Record<string, unknown>): EditInput {
    if (typeof raw.file_path !== "string" || raw.file_path.trim() === "") {
      throw new ToolExecutionError("file_path must be a non-empty string", { tool_name: this.name });
    }
    if (typeof raw.old_string !== "string") {
      throw new ToolExecutionError("old_string must be a string", { tool_name: this.name });
    }
    if (raw.old_string === "") {
      throw new ToolExecutionError(
        "old_string must be non-empty; use Write to create a file.",
        { tool_name: this.name },
      );
    }
    if (typeof raw.new_string !== "string") {
      throw new ToolExecutionError("new_string must be a string", { tool_name: this.name });
    }
    const replace_all = raw.replace_all !== undefined ? Boolean(raw.replace_all) : false;
    return { file_path: raw.file_path, old_string: raw.old_string, new_string: raw.new_string, replace_all };
  }

  summarize(input: EditInput): string {
    const relPath = input.file_path;
    return `Edit ${relPath} (${input.replace_all ? "replace all" : "replace one"})`;
  }

  async execute(input: EditInput, ctx: ToolContext): Promise<ToolResult> {
    const absPath = resolvePath(input.file_path, ctx.cwd);
    const relPath = path.relative(ctx.cwd, absPath);

    // Step 2: Enforce Read-before-Edit.
    if (!ctx.fileReadTracker.hasRead(absPath)) {
      return err("You must Read this file before editing it.", input, this);
    }

    // Step 3: Identical strings check.
    if (input.old_string === input.new_string) {
      return err("No changes to make: old_string and new_string are exactly the same.", input, this);
    }

    // Step 4: Size guard — stat before loading.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch (e: unknown) {
      const ex = e as NodeJS.ErrnoException;
      if (ex.code === "ENOENT") return err("File not found.", input, this);
      return err(`Cannot stat file: ${ex.message}`, input, this);
    }

    if (stat.size > MAX_EDIT_SIZE) {
      return err("File too large to edit; use Read + Write.", input, this);
    }

    // Step 5: Read current contents.
    let text: string;
    try {
      text = await fs.promises.readFile(absPath, "utf8");
    } catch (e: unknown) {
      const ex = e as NodeJS.ErrnoException;
      if (ex.code === "EACCES") return err("Permission denied.", input, this);
      return err(`Cannot read file: ${ex.message}`, input, this);
    }

    // Step 6: Preserve dominant line-ending style, and pick the effective needle.
    const sample = text.slice(0, 16384);
    const dominant = detectLineEnding(sample);
    let needle = input.old_string;
    let newString = input.new_string;
    if (dominant === "\r\n") {
      // Normalize bare LF in new_string to CRLF (avoid double-converting existing CRLF).
      newString = newString.replace(/\r?\n/g, "\r\n");
      // The model supplies LF-joined old_string; on a CRLF file the literal
      // match fails, so retry with a CRLF-normalized needle. Uniqueness
      // counting must use that same normalized needle.
      if (!text.includes(needle)) {
        const crlfNeedle = needle.replace(/\r?\n/g, "\r\n");
        if (text.includes(crlfNeedle)) needle = crlfNeedle;
      }
    }

    // Step 7: Count occurrences (and locate the first for the single-edit splice).
    const { count, firstIndex } = locateOccurrences(text, needle);
    if (count === 0) {
      return err("old_string not found in file.", input, this);
    }
    if (count > 1 && !input.replace_all) {
      return err(
        `old_string matches ${count} occurrences; provide more surrounding context for a unique match, or pass replace_all: true.`,
        input,
        this,
      );
    }

    // Replace literally — split+join for replace_all, and an index splice for the
    // single case so `$$`, `$&`, `` $` `` etc. in new_string are written
    // byte-literal instead of being expanded as JS replacement patterns.
    const newText = input.replace_all
      ? text.split(needle).join(newString)
      : text.slice(0, firstIndex) + newString + text.slice(firstIndex + needle.length);

    // Step 8: Atomic write.
    try {
      await atomicWriteFile(absPath, newText);
    } catch (e: unknown) {
      const ex = e as NodeJS.ErrnoException;
      return err(`Cannot write file: ${ex.message}`, input, this);
    }

    // Step 9: Diff-style summary.
    const oldLines = text.split("\n").length;
    const newLines = newText.split("\n").length;
    const delta = newLines - oldLines;
    const sign = delta >= 0 ? "+" : "";
    const summary = `${sign}${delta} lines in ${relPath}`;

    return {
      content: `Edited ${relPath}: ${summary}`,
      summary: this.summarize(input),
    };
  }
}

function err(msg: string, input: EditInput, tool: EditTool): ToolResult {
  return { content: `Error: ${msg}`, summary: tool.summarize(input), is_error: true };
}
