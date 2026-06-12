import { describe, test, expect, beforeEach } from "bun:test";
import { TaskUpdateTool } from "./task-update.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { makeToolCtx } from "./task-test-helpers.js";

describe("TaskUpdateTool", () => {
  let tool: TaskUpdateTool;
  let store: InMemorySessionStore;
  const SESSION = "sess-update";

  beforeEach(async () => {
    tool = new TaskUpdateTool();
    store = new InMemorySessionStore();
    await store.create({ id: SESSION });
    await store.createTask(SESSION, { subject: "Task one", description: "First task" });
    await store.createTask(SESSION, { subject: "Task two", description: "Second task" });
    await store.createTask(SESSION, { subject: "Task three", description: "Third task" });
  });

  // --- validate ---

  test("validate throws on missing task_id", () => {
    expect(() => tool.validate({})).toThrow();
  });

  test("validate throws on empty task_id", () => {
    expect(() => tool.validate({ task_id: "" })).toThrow();
  });

  test("validate accepts minimal input", () => {
    const result = tool.validate({ task_id: "1" });
    expect(result.task_id).toBe("1");
  });

  test("validate throws if status is non-string", () => {
    expect(() => tool.validate({ task_id: "1", status: 42 })).toThrow();
  });

  test("validate throws on an invalid status, naming the allowed values", () => {
    expect(() => tool.validate({ task_id: "1", status: "done" })).toThrow(
      /pending, in_progress, completed, deleted/,
    );
  });

  test("validate accepts each allowed status", () => {
    for (const status of ["pending", "in_progress", "completed", "deleted"]) {
      expect(tool.validate({ task_id: "1", status }).status).toBe(status);
    }
  });

  test("validate throws if add_blocks is not array of strings", () => {
    expect(() => tool.validate({ task_id: "1", add_blocks: [1, 2] })).toThrow();
  });

  // --- not found ---

  test("returns is_error true for missing task", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const result = await tool.execute({ task_id: "999" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Task not found.");
  });

  // --- status diff ---

  test("status change appears in diff output", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ task_id: "1", status: "in_progress" });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Task #1 updated:");
    expect(result.content).toContain("status pending → in_progress");
  });

  test("subject change appears in diff", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ task_id: "1", subject: "Renamed task" });
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("subject");
    expect(result.content).toContain("Renamed task");
  });

  test("owner change appears in diff", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ task_id: "1", owner: "carol" });
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("owner");
    expect(result.content).toContain("carol");
  });

  test("no-change patch reports 'no changes'", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    // Pass an empty patch (only task_id)
    const input = tool.validate({ task_id: "1" });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("no changes");
  });

  // --- edge changes ---

  test("adding edge appears in diff", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ task_id: "2", add_blocked_by: ["1"] });
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("blocked_by");
    expect(result.content).toContain("#1");
  });

  // --- cycle rejection ---

  test("cycle rejection surfaces as is_error true", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    // Set up 1 → 2
    await store.updateTask(SESSION, "1", { add_blocks: ["2"] });
    // Attempting 2 → 1 creates a cycle
    const input = tool.validate({ task_id: "2", add_blocks: ["1"] });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/cycle/i);
  });

  // --- deletion ---

  test("status: 'deleted' removes task and reports deletion", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ task_id: "1", status: "deleted" });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Task #1 deleted");
    const task = await store.getTask(SESSION, "1");
    expect(task).toBeUndefined();
  });

  test("deleting non-existent task returns is_error true", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    // Delete once
    await store.updateTask(SESSION, "1", { status: "deleted" });
    // Try to delete again
    const input = tool.validate({ task_id: "1", status: "deleted" });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Task not found.");
  });

  // --- metadata ---

  test("scope is 'write'", () => {
    expect(tool.scope).toBe("write");
  });

  test("parallelSafe is true", () => {
    expect(tool.parallelSafe).toBe(true);
  });

  test("summarize returns 'Update task #<id>'", () => {
    const input = tool.validate({ task_id: "7" });
    expect(tool.summarize(input)).toBe("Update task #7");
  });
});
