// src/sessions/store.ts
import type { InvokedSkillRecord, Message } from "../core/types.js";
import type { CreateTaskInput, Task, TaskPatch } from "./tasks.js";

/** Metadata stored about a session. */
export interface SessionRecord {
  id: string;
  created_at: string;    // ISO-8601
  updated_at: string;    // ISO-8601
  /** Arbitrary developer-supplied metadata: title, tags, project root, etc. */
  meta: Record<string, unknown>;
  /** Skills invoked in this session, in invocation order. Restored on resume. */
  invokedSkills?: InvokedSkillRecord[];
}

/** A message with append metadata. */
export interface StoredMessage {
  /** Monotonic sequence within the session, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp when the message was appended. */
  appended_at: string;
  /** The message itself, in skawld's normalized shape. */
  message: Message;
}

export interface SessionStore {
  /** Create a session. If id is provided and already exists, return the existing record. */
  create(record: { id?: string; meta?: Record<string, unknown> }): Promise<SessionRecord>;

  /**
   * Load metadata for a session. Returns undefined if not found.
   * Contract: the returned record is a copy — mutating it MUST NOT affect the store.
   */
  load(id: string): Promise<SessionRecord | undefined>;

  /** Load all messages for a session in seq order. */
  loadMessages(id: string): Promise<StoredMessage[]>;

  /**
   * Append one or more messages atomically.
   * Implementations MUST assign monotonic seq values and update updated_at on the session.
   */
  appendMessages(id: string, messages: Message[]): Promise<StoredMessage[]>;

  /**
   * Update the session's metadata (shallow merge). Read-merge-write MUST be
   * atomic so concurrent calls don't lose each other's keys.
   * Contract: throws `SessionStoreError` if the session does not exist.
   */
  updateMeta(id: string, meta: Record<string, unknown>): Promise<SessionRecord>;

  /**
   * Persist the ordered list of skills invoked in this session.
   * Overwrites the previous list — callers pass the full array each time.
   */
  setInvokedSkills(id: string, skills: InvokedSkillRecord[]): Promise<void>;

  /** List sessions, most recently updated first. */
  list(opts?: { limit?: number; offset?: number }): Promise<SessionRecord[]>;

  /** Delete a session and all its messages, tasks, task edges, and task counters. */
  delete(id: string): Promise<void>;

  /** Create a persistent task in this session. Assigns a stable, monotonically increasing id. */
  createTask(sessionId: string, input: CreateTaskInput): Promise<Task>;

  /** Load one task. Returns undefined if the task does not exist. */
  getTask(sessionId: string, taskId: string): Promise<Task | undefined>;

  /** List all tasks for this session, sorted by numeric id ascending. */
  listTasks(sessionId: string): Promise<Task[]>;

  /**
   * Patch one task. Returns undefined if the task does not exist.
   * Contract: an `add_blocks`/`add_blocked_by` edge referencing a non-existent
   * task throws `SessionStoreError`; a dependency cycle throws.
   */
  updateTask(sessionId: string, taskId: string, patch: TaskPatch): Promise<Task | undefined>;

  /** Delete one task and its dependency edges. Returns whether a row was deleted. */
  deleteTask(sessionId: string, taskId: string): Promise<boolean>;

  /**
   * Release any underlying resources. Called by Agent.close().
   * Optional — only relevant for stores with persistent handles (DB connections).
   */
  close?(): Promise<void>;
}
