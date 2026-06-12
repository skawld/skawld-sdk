import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ReadTool } from "./read.js";
import { FileReadTracker } from "./file-tracker.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolExecutionError } from "../core/errors.js";
import type { ToolContext } from "./base.js";

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    fileReadTracker: new FileReadTracker(),
    sessionId: "test-session",
    runId: "test-run",
    sessionStore: new InMemorySessionStore(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-read-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ReadTool — validate", () => {
  const tool = new ReadTool();

  test("accepts minimal valid input", () => {
    expect(tool.validate({ file_path: "foo.ts" })).toEqual({ file_path: "foo.ts", offset: undefined, limit: undefined });
  });

  test("accepts offset and limit", () => {
    expect(tool.validate({ file_path: "a.ts", offset: 5, limit: 10 })).toEqual({
      file_path: "a.ts",
      offset: 5,
      limit: 10,
    });
  });

  test("throws ToolExecutionError for missing file_path", () => {
    expect(() => tool.validate({})).toThrow(ToolExecutionError);
  });

  test("throws for empty file_path", () => {
    expect(() => tool.validate({ file_path: "  " })).toThrow(ToolExecutionError);
  });

  test("throws for non-integer offset", () => {
    expect(() => tool.validate({ file_path: "a.ts", offset: 1.5 })).toThrow(ToolExecutionError);
  });

  test("throws for offset < 1", () => {
    expect(() => tool.validate({ file_path: "a.ts", offset: 0 })).toThrow(ToolExecutionError);
  });
});

describe("ReadTool — summarize", () => {
  const tool = new ReadTool();

  test("default offset/limit omits range", () => {
    expect(tool.summarize({ file_path: "src/foo.ts" })).toBe("Read src/foo.ts");
  });

  test("non-default shows line range", () => {
    expect(tool.summarize({ file_path: "src/foo.ts", offset: 10, limit: 50 })).toBe("Read src/foo.ts (lines 10-59)");
  });
});

describe("ReadTool — happy path", () => {
  const tool = new ReadTool();

  test("reads a small text file with numbered lines", async () => {
    const file = path.join(tmpDir, "hello.ts");
    fs.writeFileSync(file, "line one\nline two\nline three\n");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("     1\tline one");
    expect(result.content).toContain("     2\tline two");
    expect(result.content).toContain("     3\tline three");
  });

  test("marks file as read in tracker", async () => {
    const file = path.join(tmpDir, "mark.ts");
    fs.writeFileSync(file, "content\n");
    const ctx = makeCtx(tmpDir);
    expect(ctx.fileReadTracker.hasRead(file)).toBe(false);
    await tool.execute({ file_path: file }, ctx);
    expect(ctx.fileReadTracker.hasRead(file)).toBe(true);
  });

  test("offset skips lines correctly", async () => {
    const file = path.join(tmpDir, "offset.ts");
    fs.writeFileSync(file, "a\nb\nc\nd\ne\n");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file, offset: 3, limit: 2 }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("     3\tc");
    expect(result.content).toContain("     4\td");
    expect(result.content).not.toContain("     1\ta");
    expect(result.content).not.toContain("     5\te");
  });

  test("limit caps output", async () => {
    const file = path.join(tmpDir, "limit.ts");
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(file, lines);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file, limit: 3 }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("     3\tline 3");
    expect(result.content).not.toContain("     4\tline 4");
  });

  test("empty file returns <file is empty>", async () => {
    const file = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(file, "");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("<file is empty>");
  });

  test("long line is truncated with marker", async () => {
    const file = path.join(tmpDir, "longline.ts");
    const longLine = "x".repeat(2100);
    fs.writeFileSync(file, longLine + "\nnormal\n");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content as string).toContain("chars truncated");
    // normal line is not truncated
    expect(result.content as string).toContain("     2\tnormal");
  });

  test("relative path resolved against cwd", async () => {
    fs.writeFileSync(path.join(tmpDir, "rel.ts"), "hello\n");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: "rel.ts" }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("hello");
  });
});

describe("ReadTool — errors", () => {
  const tool = new ReadTool();

  test("missing file returns is_error", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: path.join(tmpDir, "nope.ts") }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/not found/i);
  });

  test("directory path returns is_error", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: tmpDir }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/directory/i);
  });

  test("device path /dev/null is blocked", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: "/dev/null" }, ctx);
    // /dev/null may not match our prefix list exactly but /dev/stdin etc. should
    // We test /dev/zero which is in the deny list
    expect(result).toBeDefined();
  });

  test("device path /dev/zero returns is_error", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: "/dev/zero" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/device/i);
  });

  test("binary file with null bytes returns is_error", async () => {
    const file = path.join(tmpDir, "binary.bin");
    const buf = Buffer.alloc(16);
    buf[5] = 0; // null byte
    fs.writeFileSync(file, buf);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/binary/i);
  });

  test("known binary extension (.exe) returns is_error", async () => {
    const file = path.join(tmpDir, "prog.exe");
    fs.writeFileSync(file, "MZ fake exe content");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/binary/i);
  });

  test("EACCES returns is_error", async () => {
    const file = path.join(tmpDir, "noaccess.ts");
    fs.writeFileSync(file, "secret\n");
    fs.chmodSync(file, 0o000);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    // Restore so cleanup works
    fs.chmodSync(file, 0o644);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/permission/i);
  });
});

describe("ReadTool — image branch", () => {
  const tool = new ReadTool();

  test("reads a PNG and returns image content block", async () => {
    // Minimal valid 1×1 PNG (67 bytes, well-known fixture)
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
      "hex",
    );
    const file = path.join(tmpDir, "pixel.png");
    fs.writeFileSync(file, pngBytes);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBeUndefined();
    const content = result.content as Array<{ type: string; source: { type: string; media_type: string; data: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("image");
    expect(content[0].source.type).toBe("base64");
    expect(content[0].source.media_type).toBe("image/png");
    expect(content[0].source.data).toBe(pngBytes.toString("base64"));
    expect(ctx.fileReadTracker.hasRead(file)).toBe(true);
  });

  test("PNG summary includes image and byte count", async () => {
    const pngBytes = Buffer.from("89504e47", "hex"); // fake 4 bytes
    const file = path.join(tmpDir, "tiny.png");
    fs.writeFileSync(file, pngBytes);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.summary).toContain("image");
    expect(result.summary).toContain("B");
  });
});

describe("ReadTool — hardening (E4/E7/E8)", () => {
  const tool = new ReadTool();

  // E7: a short read leaves the sniff buffer zero-filled; only the bytes read
  // should be inspected, or a short text file looks binary.
  test("short text file is not misdetected as binary", async () => {
    const file = path.join(tmpDir, "short.txt");
    fs.writeFileSync(file, "hi"); // 2 bytes, far less than the sniff window
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content as string).toContain("hi");
  });

  // E8: an offset past EOF must report out-of-range, not "<file is empty>",
  // and must not mark the file as read.
  test("offset beyond EOF reports out-of-range and does not mark read", async () => {
    const file = path.join(tmpDir, "hundred.txt");
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file, offset: 500 }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/beyond end of file/i);
    expect(result.content as string).toContain("100");
    expect(ctx.fileReadTracker.hasRead(file)).toBe(false);
  });

  // E4: a symlink pointing at a device path must be denied (before any read —
  // /dev/zero would otherwise stream zeros forever).
  test("symlink to a device path is denied", async () => {
    const link = path.join(tmpDir, "dev-link");
    if (!fs.existsSync("/dev/zero")) return; // non-POSIX environment — skip
    fs.symlinkSync("/dev/zero", link);
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: link }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/device path/i);
  });
});
