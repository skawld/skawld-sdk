/** Integration tests for PreToolUse / PostToolUse hooks in the scheduler. */

import { describe, expect, it } from "bun:test";
import { executeToolCalls } from "./scheduler.js";
import { Agent, getAgentInternals } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { MockReadTool, MockWriteTool } from "./_test-mock-tools.js";
import type { Event, ToolCallStartEvent, PermissionRequestEvent, HookErrorEvent } from "./events.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { PermissionRule } from "../permissions/rules.js";
import type { Hooks } from "./hooks.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function neverSignal(): AbortSignal {
  return new AbortController().signal;
}

async function makeInternals(opts: {
  tools?: ToolRegistry;
  permMode?: "default" | "acceptEdits" | "yolo";
  canUseTool?: CanUseTool;
  rules?: PermissionRule[];
  hooks?: Hooks;
} = {}): Promise<{ ai: AgentInternal; si: SessionInternal }> {
  const store = new InMemorySessionStore();
  const agent = new Agent({
    provider: {
      id: "capturing",
      contextWindow: () => 200_000,
      async *stream() {
        yield { type: "message_start" as const, model: "test-model" };
        yield { type: "message_end" as const, stop_reason: "end_turn" as const, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
    model: "test-model",
    sessionStore: store,
    tools: opts.tools,
    permissions: { mode: opts.permMode ?? "yolo", canUseTool: opts.canUseTool, rules: opts.rules },
    hooks: opts.hooks,
  });
  const session = await agent.session();
  const ai = getAgentInternals(agent);
  const si = getSessionInternals(session);
  si.activeRunId = "test-run-id";
  return { ai, si };
}

async function collectGen(gen: AsyncGenerator<Event, ToolResultBlock[]>): Promise<{ events: Event[]; results: ToolResultBlock[] }> {
  const events: Event[] = [];
  let results: ToolResultBlock[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) { results = next.value ?? []; break; }
    events.push(next.value);
  }
  return { events, results };
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

describe("scheduler — PreToolUse deny", () => {
  it("synthesizes a deny, skips execute + PostToolUse, no permission evaluation", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    let postRan = false;
    const { ai, si } = await makeInternals({
      tools,
      hooks: {
        preToolUse: [{ hook: () => ({ action: "deny", reason: "blocked by policy" }) }],
        postToolUse: [{ hook: () => { postRan = true; } }],
      },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toBe("Tool call denied: blocked by policy");
    expect(write.callTimestamps).toHaveLength(0);
    expect(postRan).toBe(false);
    expect(events.some(e => e.type === "permission_request")).toBe(false);
  });
});

describe("scheduler — PreToolUse allow", () => {
  it("bypasses rules + mode + canUseTool", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    let canUseToolCalled = false;
    const canUseTool: CanUseTool = async () => { canUseToolCalled = true; return { behavior: "deny", message: "x" }; };
    const { ai, si } = await makeInternals({
      tools,
      permMode: "default", // write would normally ask
      canUseTool,
      hooks: { preToolUse: [{ hook: () => ({ action: "allow" }) }] },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(canUseToolCalled).toBe(false);
    expect(events.some(e => e.type === "permission_request")).toBe(false);
    expect(write.callTimestamps).toHaveLength(1);
    expect(results[0]!.is_error).toBeFalsy();
  });
});

describe("scheduler — PreToolUse continue + updatedInput rewrite", () => {
  it("rewrite flows into permission_request, tool_call_start, and execute", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    const canUseTool: CanUseTool = async () => ({ behavior: "allow" });
    const { ai, si } = await makeInternals({
      tools,
      permMode: "default",
      canUseTool,
      hooks: {
        preToolUse: [{ hook: () => ({ action: "continue", updatedInput: { path: "/staged" } }) }],
      },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite", { path: "/orig" })], ai, si, neverSignal()),
    );

    const req = events.find(e => e.type === "permission_request") as PermissionRequestEvent;
    expect(req.requests[0]!.input).toEqual({ path: "/staged" });
    const start = events.find(e => e.type === "tool_call_start") as ToolCallStartEvent;
    expect(start.input).toEqual({ path: "/staged" });
    expect(write.capturedInputs[0]).toEqual({ path: "/staged" });
    expect(results[0]!.is_error).toBeFalsy();
  });
});

describe("scheduler — PreToolUse ask", () => {
  it("forces canUseTool even under yolo mode where the call would be allowed", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    let canUseToolCalled = false;
    const canUseTool: CanUseTool = async () => { canUseToolCalled = true; return { behavior: "allow" }; };
    const { ai, si } = await makeInternals({
      tools,
      permMode: "yolo",
      canUseTool,
      hooks: { preToolUse: [{ hook: () => ({ action: "ask" }) }] },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(canUseToolCalled).toBe(true);
    expect(events.some(e => e.type === "permission_request")).toBe(true);
    expect(results[0]!.is_error).toBeFalsy();
  });

  it("a matching deny rule still wins over a hook-forced ask", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    let canUseToolCalled = false;
    const canUseTool: CanUseTool = async () => { canUseToolCalled = true; return { behavior: "allow" }; };
    const { ai, si } = await makeInternals({
      tools,
      permMode: "yolo",
      canUseTool,
      rules: [{ kind: "tool", tool: "MockWrite", decision: "deny" }],
      hooks: { preToolUse: [{ hook: () => ({ action: "ask" }) }] },
    });

    const { results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(canUseToolCalled).toBe(false);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool call denied");
    expect(write.callTimestamps).toHaveLength(0);
  });
});

describe("scheduler — PreToolUse fail-closed", () => {
  it("a throwing hook denies the call and emits a hook_error event", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);
    const { ai, si } = await makeInternals({
      tools,
      hooks: { preToolUse: [{ hook: () => { throw new Error("guard crashed"); } }] },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    const hookErr = events.find(e => e.type === "hook_error") as HookErrorEvent;
    expect(hookErr).toBeDefined();
    expect(hookErr.hook_event).toBe("PreToolUse");
    expect(hookErr.tool_use_id).toBe("tu-1");
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool call denied: Hook failed: guard crashed");
    expect(write.callTimestamps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

describe("scheduler — PostToolUse additionalContext", () => {
  it("appends a system-reminder-wrapped string to the tool_result content", async () => {
    const write = new MockWriteTool("write result");
    const tools = new ToolRegistry();
    tools.register(write);
    const { ai, si } = await makeInternals({
      tools,
      hooks: { postToolUse: [{ hook: () => ({ additionalContext: "edit the template instead" }) }] },
    });

    const { results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(results[0]!.content).toBe(
      "write result\n\n<system-reminder>\nedit the template instead\n</system-reminder>",
    );
  });

  it("fails open on throw: result unchanged + hook_error event", async () => {
    const write = new MockWriteTool("write result");
    const tools = new ToolRegistry();
    tools.register(write);
    const { ai, si } = await makeInternals({
      tools,
      hooks: { postToolUse: [{ hook: () => { throw new Error("post crashed"); } }] },
    });

    const { events, results } = await collectGen(
      executeToolCalls([makeToolUseBlock("tu-1", "MockWrite")], ai, si, neverSignal()),
    );

    expect(results[0]!.content).toBe("write result");
    const hookErr = events.find(e => e.type === "hook_error") as HookErrorEvent;
    expect(hookErr.hook_event).toBe("PostToolUse");
    expect(hookErr.tool_use_id).toBe("tu-1");
  });

  it("fires per-call in a parallel batch", async () => {
    const r1 = new MockReadTool("a"); r1.deferred.resolve();
    const r2 = new MockReadTool("b"); r2.deferred.resolve();
    (r2 as { name: string }).name = "MockRead2";
    const tools = new ToolRegistry();
    tools.register(r1);
    tools.register(r2);
    const { ai, si } = await makeInternals({
      tools,
      hooks: { postToolUse: [{ matcher: "MockRead*", hook: (input) => ({ additionalContext: `seen ${input.tool_use_id}` }) }] },
    });

    const { results } = await collectGen(
      executeToolCalls(
        [makeToolUseBlock("tu-1", "MockRead"), makeToolUseBlock("tu-2", "MockRead2")],
        ai, si, neverSignal(),
      ),
    );

    expect(results[0]!.content).toContain("seen tu-1");
    expect(results[1]!.content).toContain("seen tu-2");
  });
});
