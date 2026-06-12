import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Re-export ripgrep helper (split to keep file under 200 LOC)
export type { RipgrepResult } from "./_helpers-ripgrep.js";
export { runRipgrep } from "./_helpers-ripgrep.js";

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------

/** Resolve a user-supplied path against cwd. Expands leading `~/`. */
export function resolvePath(input: string, cwd: string): string {
  const expanded = input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : input;
  return path.resolve(cwd, expanded);
}

// ---------------------------------------------------------------------------
// canonicalizePath
// ---------------------------------------------------------------------------

/**
 * Resolve a path to its real, symlink-free form. For a path that doesn't exist
 * yet (a new file), canonicalize the nearest existing ancestor and append the
 * remainder, so callers get a stable identity that follows symlinks into the
 * real directory tree. Falls back to a plain absolute resolve at the FS root.
 */
export function canonicalizePath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    let dir = path.dirname(abs);
    const trailing: string[] = [path.basename(abs)];
    for (;;) {
      try {
        const realDir = fs.realpathSync.native(dir);
        return path.join(realDir, ...trailing.slice().reverse());
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return abs; // reached root with nothing resolved
        trailing.push(path.basename(dir));
        dir = parent;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// findExecutable
// ---------------------------------------------------------------------------

// Process-lifetime cache. Acceptable for v1 short-lived agents.
const executableCache = new Map<string, string | null>();

/**
 * Search PATH for an executable. Returns the full path or null if not found.
 * Result is memoized for the process lifetime.
 */
export function findExecutable(name: string): string | null {
  if (executableCache.has(name)) return executableCache.get(name)!;

  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        executableCache.set(name, candidate);
        return candidate;
      } catch {
        // not found here
      }
    }
  }

  executableCache.set(name, null);
  return null;
}

// ---------------------------------------------------------------------------
// formatNumberedLines
// ---------------------------------------------------------------------------

/**
 * Format file content with `cat -n`-style line numbers.
 * Line numbers are right-aligned in a 6-character field, separated by a tab.
 */
export function formatNumberedLines(content: string, startLine = 1): string {
  if (content === "") return "";
  const lines = content.split("\n");
  // Preserve a trailing newline: if original ended with \n, last element is "".
  // We don't emit a spurious numbered empty line for it.
  const hasTrailing = lines.at(-1) === "";
  const toFormat = hasTrailing ? lines.slice(0, -1) : lines;
  const formatted = toFormat
    .map((line, i) => `${String(i + startLine).padStart(6, " ")}\t${line}`)
    .join("\n");
  return hasTrailing ? formatted + "\n" : formatted;
}

// ---------------------------------------------------------------------------
// truncateOutput
// ---------------------------------------------------------------------------

/**
 * Truncate text at maxChars, appending a marker with the omitted char count.
 * Returns the original string unchanged if it fits.
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return text.slice(0, maxChars) + `\n… (${omitted} chars truncated)`;
}

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

/**
 * Write content to absPath atomically:
 *   1. Write to a temp file in the same directory.
 *   2. Preserve the existing file's mode (if it exists).
 *   3. fsync the temp file.
 *   4. Rename into place.
 *   5. Clean up temp on failure.
 *
 * Temp files are named `.tmp-skawld-<uuid>-<basename>` for easy identification.
 */
export async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  // Canonicalize first so an edit through a symlink writes *through* the link
  // (the temp file and rename target live in the real directory), preserving
  // the symlink instead of replacing it with a regular file.
  const canonical = canonicalizePath(absPath);
  const dir = path.dirname(canonical);
  const base = path.basename(canonical);
  const tmp = path.join(dir, `.tmp-skawld-${randomUUID()}-${base}`);

  // Determine existing mode so we can preserve it.
  let existingMode: number | undefined;
  try {
    existingMode = fs.statSync(canonical).mode;
  } catch {
    // File doesn't exist yet — no mode to preserve.
  }

  try {
    await fs.promises.writeFile(tmp, content, { encoding: "utf8" });

    // Apply mode before rename so the target inherits correct permissions.
    if (existingMode !== undefined) {
      await fs.promises.chmod(tmp, existingMode);
    }

    // fsync via a raw fd to guarantee durability before rename.
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, canonical);
  } catch (err) {
    // Best-effort cleanup.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
