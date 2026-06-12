import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";
import { resolvePath, canonicalizePath, formatNumberedLines, truncateOutput } from "./_helpers.js";

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    file_path: { type: "string", description: "Absolute or relative path to the file." },
    offset: { type: "number", description: "1-indexed line to start at. Defaults to 1." },
    limit: { type: "number", description: "Maximum number of lines to read. Defaults to 2000." },
  },
  required: ["file_path"],
};

// Extensions that map to images (returned as image content blocks).
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
// Extensions that are known binary — return error instead of garbled text.
const BINARY_EXTS = new Set([".exe", ".so", ".dylib", ".o", ".a", ".zip", ".tar", ".gz", ".pdf"]);
// Image media types by extension.
const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Device paths to block (prefix-based deny list).
const DEVICE_PREFIXES = ["/dev/zero", "/dev/random", "/dev/urandom", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/proc/"];

const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1 MiB
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MiB
const BINARY_DETECT_BYTES = 8192;
const MAX_LINE_LENGTH = 2000;

function isDevicePath(absPath: string): boolean {
  return DEVICE_PREFIXES.some(prefix => absPath.startsWith(prefix));
}

function detectNullBytes(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Truncate long lines within already-formatted output (after numbering). */
function truncateLines(content: string): string {
  return content
    .split("\n")
    .map(line => {
      // Find the tab separator (line number prefix ends at first \t).
      const tabIdx = line.indexOf("\t");
      if (tabIdx === -1) return truncateOutput(line, MAX_LINE_LENGTH);
      const prefix = line.slice(0, tabIdx + 1);
      const body = line.slice(tabIdx + 1);
      if (body.length <= MAX_LINE_LENGTH) return line;
      const omitted = body.length - MAX_LINE_LENGTH;
      return prefix + body.slice(0, MAX_LINE_LENGTH) + `… (${omitted} chars truncated)`;
    })
    .join("\n");
}

interface StreamReadResult {
  content: string;
  /** Total lines scanned. Authoritative only when the whole file was read. */
  totalLines: number;
}

/** Read lines [startLine, startLine+limit) from a stream, 1-indexed. */
async function readLinesStream(
  absPath: string,
  startLine: number,
  limit: number,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let lineNum = 0;
    let done = false;
    let buf = "";

    const stream = createReadStream(absPath, { encoding: "utf8" });

    const onAbort = () => {
      stream.destroy();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    stream.on("data", (chunk: string) => {
      if (done) { stream.destroy(); return; }
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lineNum++;
        if (lineNum >= startLine && lines.length < limit) {
          lines.push(buf.slice(0, nl));
        }
        buf = buf.slice(nl + 1);
        if (lines.length >= limit) { done = true; stream.destroy(); return; }
      }
    });

    stream.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    stream.on("close", () => {
      signal.removeEventListener("abort", onAbort);
      // Handle remaining buf (file without trailing newline).
      if (!done && buf.length > 0) {
        lineNum++;
        if (lineNum >= startLine && lines.length < limit) {
          lines.push(buf);
        }
      }
      resolve({ content: lines.join("\n"), totalLines: lineNum });
    });
  });
}

export class ReadTool implements Tool<ReadInput> {
  readonly name = "Read";
  readonly description =
    "Reads a file from the local filesystem. Supports text and images (PNG/JPEG/GIF/WebP). " +
    "Use absolute paths or paths relative to the working directory. By default reads up " +
    "to 2000 lines from the start; use 'offset' (1-indexed) and 'limit' for larger files. " +
    "Lines longer than 2000 chars are truncated. Always Read a file before Editing it.";
  readonly input_schema = SCHEMA;
  readonly scope = "read" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): ReadInput {
    if (typeof raw.file_path !== "string" || raw.file_path.trim() === "") {
      throw new ToolExecutionError("file_path must be a non-empty string", { tool_name: this.name });
    }
    const offset = raw.offset !== undefined ? Number(raw.offset) : undefined;
    const limit = raw.limit !== undefined ? Number(raw.limit) : undefined;
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
      throw new ToolExecutionError("offset must be a positive integer (1-indexed)", { tool_name: this.name });
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ToolExecutionError("limit must be a positive integer", { tool_name: this.name });
    }
    return { file_path: raw.file_path, offset, limit };
  }

  summarize(input: ReadInput): string {
    const relPath = input.file_path;
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;
    if (offset === 1 && limit === 2000) return `Read ${relPath}`;
    return `Read ${relPath} (lines ${offset}-${offset + limit - 1})`;
  }

  async execute(input: ReadInput, ctx: ToolContext): Promise<ToolResult> {
    const absPath = resolvePath(input.file_path, ctx.cwd);
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;

    // Device-path guard. Canonicalize first so a symlink pointing at a device
    // (e.g. /tmp/x → /dev/stdin) can't bypass the deny list.
    if (isDevicePath(absPath) || isDevicePath(canonicalizePath(absPath))) {
      return {
        content: `Error: ${absPath} is a device path and cannot be read.`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Stat the file.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return error("File not found.", input, this);
      if (e.code === "EACCES") return error("Permission denied.", input, this);
      return error(`Cannot stat file: ${e.message}`, input, this);
    }

    if (stat.isDirectory()) return error("Path is a directory.", input, this);

    const ext = path.extname(absPath).toLowerCase();

    // Image branch.
    if (IMAGE_EXTS.has(ext)) {
      if (stat.size > MAX_IMAGE_SIZE) {
        return error(`Image file too large (${stat.size} bytes; max 5 MiB). Use Bash to inspect.`, input, this);
      }
      let imgBuf: Buffer;
      try {
        imgBuf = await fs.promises.readFile(absPath);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EACCES") return error("Permission denied.", input, this);
        return error(`Cannot read file: ${e.message}`, input, this);
      }
      ctx.fileReadTracker.markRead(absPath);
      const data = imgBuf.toString("base64");
      const media_type = IMAGE_MEDIA[ext] ?? "image/png";
      const bytes = imgBuf.length;
      return {
        content: [{ type: "image", source: { type: "base64", media_type, data } }],
        summary: `Read image ${path.relative(ctx.cwd, absPath)} (${bytes}B)`,
      };
    }

    // Known binary extensions.
    if (BINARY_EXTS.has(ext)) {
      return error(`Binary file (${ext}). Use Bash to inspect binary files.`, input, this);
    }

    // Null-byte binary detection on first 8 KiB.
    if (stat.size > 0) {
      let fd: fs.promises.FileHandle;
      try {
        fd = await fs.promises.open(absPath, "r");
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EACCES") return error("Permission denied.", input, this);
        return error(`Cannot open file: ${e.message}`, input, this);
      }
      try {
        const sniffBuf = Buffer.alloc(Math.min(BINARY_DETECT_BYTES, stat.size));
        const { bytesRead } = await fd.read(sniffBuf, 0, sniffBuf.length, 0);
        // Sniff only the bytes actually read — a short read leaves the buffer
        // tail zero-filled, which would otherwise look like null bytes.
        if (detectNullBytes(sniffBuf.subarray(0, bytesRead))) {
          return error("Binary file (null bytes detected). Use Bash to inspect.", input, this);
        }
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        return error(`Cannot read file: ${e.message}`, input, this);
      } finally {
        await fd.close();
      }
    }

    // Empty file.
    if (stat.size === 0) {
      ctx.fileReadTracker.markRead(absPath);
      return {
        content: "<file is empty>",
        summary: this.summarize(input),
      };
    }

    // Read content.
    let rawLines: string;
    const useStreaming = offset > 1 || stat.size > LARGE_FILE_THRESHOLD;
    if (useStreaming) {
      let result: StreamReadResult;
      try {
        result = await readLinesStream(absPath, offset, limit, ctx.signal);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if ((e as Error).message === "aborted") return error("Read aborted.", input, this);
        if (e.code === "EACCES") return error("Permission denied.", input, this);
        return error(`Cannot read file: ${(e as Error).message}`, input, this);
      }
      // An offset past the last line yields no content. Report it explicitly
      // (and do NOT mark the file read) so the model doesn't mistake a
      // non-empty file for an empty one and overwrite it.
      if (result.content === "" && offset > result.totalLines) {
        return error(
          `offset ${offset} is beyond end of file (${result.totalLines} lines total).`,
          input,
          this,
        );
      }
      rawLines = result.content;
    } else {
      // Fast path: read whole file and slice.
      let text: string;
      try {
        text = await fs.promises.readFile(absPath, "utf8");
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EACCES") return error("Permission denied.", input, this);
        return error(`Cannot read file: ${e.message}`, input, this);
      }
      const allLines = text.split("\n");
      // Remove phantom trailing empty from trailing newline.
      if (allLines.at(-1) === "") allLines.pop();
      rawLines = allLines.slice(offset - 1, offset - 1 + limit).join("\n");
    }

    ctx.fileReadTracker.markRead(absPath);

    if (rawLines === "") {
      return {
        content: "<file is empty>",
        summary: this.summarize(input),
      };
    }

    const formatted = formatNumberedLines(rawLines, offset);
    const truncated = truncateLines(formatted);

    return {
      content: truncated,
      summary: this.summarize(input),
    };
  }
}

function error(msg: string, input: ReadInput, tool: ReadTool): ToolResult {
  return { content: `Error: ${msg}`, summary: tool.summarize(input), is_error: true };
}
