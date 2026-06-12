import { canonicalizePath } from "./_helpers.js";

/**
 * Tracks which files have been Read during the current session.
 * The Edit tool checks this and refuses to edit a file that has not been Read.
 * Cleared per-session, not per-run; Reads in earlier runs still count.
 * Held in memory only — not persisted.
 *
 * Keys are canonical (symlink-resolved) paths so that a file Read via one alias
 * and Edited via another (a symlink, or after `cd -P`) is recognized as the
 * same file.
 */
export class FileReadTracker {
  private read = new Set<string>();

  /** Canonicalize the path, then mark as read. */
  markRead(absPath: string): void {
    this.read.add(canonicalizePath(absPath));
  }

  /** Returns true if the path has been marked as read. */
  hasRead(absPath: string): boolean {
    return this.read.has(canonicalizePath(absPath));
  }

  /** Clear all tracked paths (e.g. on session reset). */
  clear(): void {
    this.read.clear();
  }
}
