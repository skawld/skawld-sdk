import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";
import { resolvePath, atomicWriteFile } from "./_helpers.js";

export interface WriteInput {
  file_path: string;
  content: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    file_path: { type: "string", description: "Absolute or relative path to write." },
    content: { type: "string", description: "Full file contents." },
  },
  required: ["file_path", "content"],
};

export class WriteTool implements Tool<WriteInput> {
  readonly name = "Write";
  readonly description =
    "Creates a new file or overwrites an existing one. If the file already exists and " +
    "has not been Read in this session, the write will be refused — Read the file first " +
    "to confirm you understand its current contents. Parent directories are created as " +
    "needed. Writes are atomic (temp file + rename).";
  readonly input_schema = SCHEMA;
  readonly scope = "write" as const;
  readonly parallelSafe = false;

  validate(raw: Record<string, unknown>): WriteInput {
    if (typeof raw.file_path !== "string" || raw.file_path.trim() === "") {
      throw new ToolExecutionError("file_path must be a non-empty string", { tool_name: this.name });
    }
    if (typeof raw.content !== "string") {
      throw new ToolExecutionError("content must be a string", { tool_name: this.name });
    }
    return { file_path: raw.file_path, content: raw.content };
  }

  summarize(input: WriteInput): string {
    const byteCount = Buffer.byteLength(input.content, "utf8");
    const relPath = input.file_path;
    return `Write ${byteCount}B to ${relPath}`;
  }

  async execute(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    const absPath = resolvePath(input.file_path, ctx.cwd);
    const relPath = path.relative(ctx.cwd, absPath);

    const exists = fs.existsSync(absPath);
    // Reject writing onto a directory (or other non-regular file) with a clear
    // message rather than a misleading read-before-write error.
    if (exists && !fs.statSync(absPath).isFile()) {
      return {
        content: `Error: ${relPath} exists and is not a regular file.`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Read-before-overwrite: if file exists and hasn't been read, refuse.
    if (exists && !ctx.fileReadTracker.hasRead(absPath)) {
      return {
        content:
          `Error: ${relPath} already exists and has not been Read in this session. ` +
          "Read the file first to confirm you understand its current contents, then Write.",
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Ensure parent directory exists.
    const dir = path.dirname(absPath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      return {
        content: `Error: Cannot create directory ${dir}: ${e.message}`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Write atomically.
    try {
      await atomicWriteFile(absPath, input.content);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      return {
        content: `Error: Cannot write file: ${e.message}`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Mark as read so subsequent Edits don't require a re-Read.
    ctx.fileReadTracker.markRead(absPath);

    const byteCount = Buffer.byteLength(input.content, "utf8");
    return {
      content: `wrote ${byteCount} bytes to ${relPath}`,
      summary: this.summarize(input),
    };
  }
}
