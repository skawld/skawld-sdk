// src/sessions/memory.ts
import type { InvokedSkillRecord, Message } from "../core/types.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./store.js";
import type { CreateTaskInput, Task, TaskPatch, TaskStatus } from "./tasks.js";
import { hasCycle } from "./sqlite-helpers.js";
import { SessionStoreError } from "../core/errors.js";

interface EdgeRow { from: string; to: string }

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private invokedSkills = new Map<string, InvokedSkillRecord[]>();
  private messages = new Map<string, StoredMessage[]>();
  private tasks = new Map<string, Map<string, Omit<Task, "blocks" | "blocked_by">>>();
  private taskCounters = new Map<string, number>();
  /** key = `${sessionId}:${from}:${to}` */
  private edges = new Map<string, EdgeRow & { sessionId: string }>();

  async create(record: { id?: string; meta?: Record<string, unknown> }): Promise<SessionRecord> {
    const id = record.id ?? crypto.randomUUID();
    if (this.sessions.has(id)) return this.sessions.get(id)!;
    const now = new Date().toISOString();
    const rec: SessionRecord = { id, created_at: now, updated_at: now, meta: record.meta ?? {} };
    this.sessions.set(id, rec);
    return rec;
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const rec = this.sessions.get(id);
    if (!rec) return undefined;
    // Return a deep-enough copy so callers mutating the result can't reach into
    // the store's live record (sqlite returns freshly parsed copies).
    const copy: SessionRecord = { ...rec, meta: { ...rec.meta } };
    const skills = this.invokedSkills.get(id);
    if (skills && skills.length > 0) copy.invokedSkills = skills.slice();
    return copy;
  }

  async setInvokedSkills(id: string, skills: InvokedSkillRecord[]): Promise<void> {
    this.invokedSkills.set(id, skills.slice());
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, updated_at: new Date().toISOString() });
  }

  async loadMessages(id: string): Promise<StoredMessage[]> {
    return (this.messages.get(id) ?? []).slice().sort((a, b) => a.seq - b.seq);
  }

  async appendMessages(id: string, messages: Message[]): Promise<StoredMessage[]> {
    const existing = this.messages.get(id) ?? [];
    // Running max (not Math.max(...spread)) to avoid a call-stack overflow at ~100k+ messages.
    let maxSeq = 0;
    for (const m of existing) if (m.seq > maxSeq) maxSeq = m.seq;
    const now = new Date().toISOString();
    const appended: StoredMessage[] = messages.map((msg, i) => ({
      seq: maxSeq + i + 1,
      appended_at: now,
      message: msg,
    }));
    this.messages.set(id, [...existing, ...appended]);
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, updated_at: now });
    return appended;
  }

  async updateMeta(id: string, meta: Record<string, unknown>): Promise<SessionRecord> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionStoreError(`Cannot updateMeta: session not found: ${id}`);
    const updated = { ...session, meta: { ...session.meta, ...meta }, updated_at: new Date().toISOString() };
    this.sessions.set(id, updated);
    return { ...updated, meta: { ...updated.meta } };
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<SessionRecord[]> {
    const all = [...this.sessions.values()].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at)
    );
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit;
    const sliced = all.slice(offset, limit !== undefined ? offset + limit : undefined);
    return sliced;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    this.messages.delete(id);
    this.tasks.delete(id);
    this.taskCounters.delete(id);
    // Remove edges for this session
    for (const [key, edge] of this.edges) {
      if (edge.sessionId === id) this.edges.delete(key);
    }
  }

  private getEdgesForSession(sessionId: string): EdgeRow[] {
    const result: EdgeRow[] = [];
    for (const edge of this.edges.values()) {
      if (edge.sessionId === sessionId) result.push({ from: edge.from, to: edge.to });
    }
    return result;
  }

  private edgeKey(sessionId: string, from: string, to: string): string {
    return `${sessionId}:${from}:${to}`;
  }

  private buildAdj(sessionId: string): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    for (const e of this.getEdgesForSession(sessionId)) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      adj.get(e.from)!.add(e.to);
    }
    return adj;
  }

  private getTaskBlocks(sessionId: string, taskId: string): { blocks: string[]; blocked_by: string[] } {
    const blocks: string[] = [];
    const blocked_by: string[] = [];
    for (const e of this.getEdgesForSession(sessionId)) {
      if (e.from === taskId) blocks.push(e.to);
      if (e.to === taskId) blocked_by.push(e.from);
    }
    return { blocks, blocked_by };
  }

  private hydrateTask(base: Omit<Task, "blocks" | "blocked_by">, sessionId: string): Task {
    const { blocks, blocked_by } = this.getTaskBlocks(sessionId, base.id);
    return { ...base, blocks, blocked_by };
  }

  async createTask(sessionId: string, input: CreateTaskInput): Promise<Task> {
    const counter = this.taskCounters.get(sessionId) ?? 1;
    const taskId = String(counter);
    this.taskCounters.set(sessionId, counter + 1);
    const now = new Date().toISOString();
    const base: Omit<Task, "blocks" | "blocked_by"> = {
      id: taskId, session_id: sessionId,
      subject: input.subject, description: input.description,
      active_form: input.active_form,
      status: "pending", owner: undefined,
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
      created_at: now, updated_at: now,
    };
    if (!this.tasks.has(sessionId)) this.tasks.set(sessionId, new Map());
    this.tasks.get(sessionId)!.set(taskId, base);
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, updated_at: now });
    return this.hydrateTask(base, sessionId);
  }

  async getTask(sessionId: string, taskId: string): Promise<Task | undefined> {
    const base = this.tasks.get(sessionId)?.get(taskId);
    if (!base) return undefined;
    return this.hydrateTask(base, sessionId);
  }

  async listTasks(sessionId: string): Promise<Task[]> {
    const map = this.tasks.get(sessionId);
    if (!map) return [];
    return [...map.values()]
      .sort((a, b) => parseInt(a.id) - parseInt(b.id))
      .map(base => this.hydrateTask(base, sessionId));
  }

  async updateTask(sessionId: string, taskId: string, patch: TaskPatch): Promise<Task | undefined> {
    const sessionTasks = this.tasks.get(sessionId);
    const base = sessionTasks?.get(taskId);
    if (!base) return undefined;

    if (patch.status === "deleted") {
      sessionTasks!.delete(taskId);
      // Remove all edges involving this task
      for (const [key, edge] of this.edges) {
        if (edge.sessionId === sessionId && (edge.from === taskId || edge.to === taskId)) {
          this.edges.delete(key);
        }
      }
      return undefined;
    }

    // Reject edges that reference a non-existent task (mirror sqlite's FK throw,
    // with a clean message). Validate before any mutation so nothing is staged.
    for (const toId of patch.add_blocks ?? []) {
      if (!sessionTasks!.has(toId)) {
        throw new SessionStoreError(`Cannot add blocks edge: task '${toId}' does not exist in session '${sessionId}'`);
      }
    }
    for (const fromId of patch.add_blocked_by ?? []) {
      if (!sessionTasks!.has(fromId)) {
        throw new SessionStoreError(`Cannot add blocked_by edge: task '${fromId}' does not exist in session '${sessionId}'`);
      }
    }

    const now = new Date().toISOString();
    const updated: Omit<Task, "blocks" | "blocked_by"> = {
      ...base,
      ...(patch.subject !== undefined && { subject: patch.subject }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.active_form !== undefined && { active_form: patch.active_form }),
      ...(patch.status !== undefined && { status: patch.status as TaskStatus }),
      ...(patch.owner !== undefined && { owner: patch.owner }),
      updated_at: now,
    };

    // Metadata shallow merge with null-deletes-key
    if (patch.metadata !== undefined) {
      const existing: Record<string, unknown> = { ...(base.metadata ?? {}) };
      for (const [k, v] of Object.entries(patch.metadata)) {
        if (v === null) delete existing[k];
        else existing[k] = v;
      }
      updated.metadata = Object.keys(existing).length > 0 ? existing : undefined;
    }

    // Build adj with current edges, apply removals, stage additions, check cycle
    const adj = this.buildAdj(sessionId);

    for (const toId of patch.remove_blocks ?? []) {
      adj.get(taskId)?.delete(toId);
      this.edges.delete(this.edgeKey(sessionId, taskId, toId));
    }
    for (const fromId of patch.remove_blocked_by ?? []) {
      adj.get(fromId)?.delete(taskId);
      this.edges.delete(this.edgeKey(sessionId, fromId, taskId));
    }

    const edgesToAdd: Array<[string, string]> = [];
    for (const toId of patch.add_blocks ?? []) {
      if (!adj.has(taskId)) adj.set(taskId, new Set());
      adj.get(taskId)!.add(toId);
      edgesToAdd.push([taskId, toId]);
    }
    for (const fromId of patch.add_blocked_by ?? []) {
      if (!adj.has(fromId)) adj.set(fromId, new Set());
      adj.get(fromId)!.add(taskId);
      edgesToAdd.push([fromId, taskId]);
    }

    if (edgesToAdd.length > 0 && hasCycle(adj)) {
      throw new Error("Dependency cycle detected");
    }

    for (const [from, to] of edgesToAdd) {
      const key = this.edgeKey(sessionId, from, to);
      this.edges.set(key, { sessionId, from, to });
    }

    sessionTasks!.set(taskId, updated);
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, updated_at: now });

    return this.hydrateTask(updated, sessionId);
  }

  async deleteTask(sessionId: string, taskId: string): Promise<boolean> {
    const sessionTasks = this.tasks.get(sessionId);
    if (!sessionTasks?.has(taskId)) return false;
    sessionTasks.delete(taskId);
    for (const [key, edge] of this.edges) {
      if (edge.sessionId === sessionId && (edge.from === taskId || edge.to === taskId)) {
        this.edges.delete(key);
      }
    }
    return true;
  }
}
