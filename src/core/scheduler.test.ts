/** Unit tests for the scheduler (Phase 4). */

import { describe, expect, it } from "bun:test";
import { executeToolCalls } from "./scheduler.js";
import { Agent, getAgentInternals } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { AbortError } from "./errors.js";
import {
  MockReadTool,
  MockWriteTool,
  MockAlwaysFailTool,
  MockAbortAwareTool,
  MockAbortAwareReadTool,
} from "./_test-mock-tools.js";
import type { Event, ToolCallStartEvent, ToolCallEndEvent, PermissionRequestEvent } from "./events.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function makeAbortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

function neverSignal(): AbortSignal {
  return new AbortController().signal;
}

interface Internals {
  ai: AgentInternal;
  si: SessionInternal;
}

async function makeInternals(opts: {
  tools?: ToolRegistry;
  permMode?: "default" | "acceptEdits" | "yolo";
  canUseTool?: CanUseTool;
} = {}): Promise<Internals> {
  const store = new InMemorySessionStore();

  const capturingProvider: import("../providers/base.js").BaseProvider = {
    id: "capturing",
    contextWindow: () => 200_000,
    async *stream() {
      yield { type: "message_start" as const, model: "test-model" };
      yield { type: "text_delta" as const, text: "ok" };
      yield {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };

  const agent = new Agent({
    provider: capturingProvider,
    model: "test-model",
    sessionStore: store,
    tools: opts.tools,
    permissions: {
      mode: opts.permMode ?? "yolo",
      canUseTool: opts.canUseTool,
    },
  });

  const session = await agent.session();
  const ai = getAgentInternals(agent);
  const si = getSessionInternals(session);
  // Simulate what runLoop does: set an activeRunId
  si.activeRunId = "test-run-id";

  return { ai, si };
}

async function collectGen(
  gen: AsyncGenerator<Event, ToolResultBlock[]>,
): Promise<{ events: Event[]; results: ToolResultBlock[] }> {
  const events: Event[] = [];
  let results: ToolResultBlock[] = [];

  while (true) {
    const next = await gen.next();
    if (next.done) {
      results = next.value ?? [];
      break;
    }
    events.push(next.value);
  }

  return { events, results };
}

// ---------------------------------------------------------------------------
// Test: Unknown tool name
// ---------------------------------------------------------------------------

describe("scheduler — unknown tool", () => {
  it("returns is_error tool_result with correct message; emits start+end events", async () => {
    const tools = new ToolRegistry();
    const { ai, si } = await makeInternals({ tools });
    const blocks = [makeToolUseBlock("tu-1", "NonExistentTool")];

    const gen = executeToolCalls(blocks, ai, si, neverSignal());
    const { events, results } = await collectGen(gen);

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.tool_name).toBe("NonExistentTool");
    expect(ends[0]!.is_error).toBe(true);

    expect(results).toHaveLength(1);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("NonExistentTool");
    expect(results[0]!.content).toContain("not registered");
  });
});

// ---------------------------------------------------------------------------
// Test: Invalid JSON input
// ---------------------------------------------------------------------------

describe("scheduler — invalid JSON input", () => {
  it("returns is_error with 'Tool input was not valid JSON' message", async () => {
    const tools = new ToolRegistry();
    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-bad", "MockRead", {
      __invalidJson: true,
      raw: "{not json",
    });
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(ends[0]!.is_error).toBe(true);

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool input was not valid JSON");
    expect(results[0]!.content).toContain("{not json");
  });
});

// ---------------------------------------------------------------------------
// Test: Validation failure
// ---------------------------------------------------------------------------

describe("scheduler — validate throws", () => {
  it("returns is_error result with validation message; execute never called", async () => {
    const validateFail: import("../tools/base.js").Tool<Record<string, unknown>> = {
      name: "MockValidateFail",
      description: "fails validate",
      scope: "write",
      parallelSafe: false,
      input_schema: { type: "object", properties: {}, required: [] },
      validate(): Record<string, unknown> {
        throw new Error("bad input shape");
      },
      async execute(): Promise<import("../tools/base.js").ToolResult> {
        throw new Error("should not be called");
      },
      summarize(): string {
        return "MockValidateFail(...)";
      },
    };

    const tools = new ToolRegistry();
    tools.register(validateFail);
    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-v", "MockValidateFail");
    const { results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("bad input shape");
  });
});

// ---------------------------------------------------------------------------
// Test: Permission deny
// ---------------------------------------------------------------------------

describe("scheduler — permission deny", () => {
  it("is_error result 'Tool call denied'; execute not called", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "nope",
    });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-d", "MockWrite");
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    // A PermissionRequestEvent should have been emitted (the call went to "ask" path)
    const permReq = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReq).toHaveLength(1);

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool call denied");
    expect(results[0]!.content).toContain("nope");

    // execute never called
    expect(write.callTimestamps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Permission ask → allow (PermissionRequestEvent emitted)
// ---------------------------------------------------------------------------

describe("scheduler — permission ask → allow", () => {
  it("emits PermissionRequestEvent then runs the tool", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({ behavior: "allow" });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-ask", "MockWrite");
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0]!.requests).toHaveLength(1);
    expect(permReqs[0]!.requests[0]!.tool_use_id).toBe("tu-ask");

    // PermissionRequestEvent must come before any start event
    const permIdx = events.findIndex(e => e.type === "permission_request");
    const startIdx = events.findIndex(e => e.type === "tool_call_start");
    expect(permIdx).toBeLessThan(startIdx);

    expect(results[0]!.is_error).toBeFalsy();
    expect(write.callTimestamps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: Permission ask → allow with updatedInput
// ---------------------------------------------------------------------------

describe("scheduler — permission updatedInput", () => {
  it("execute receives the updatedInput from canUseTool", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({
      behavior: "allow",
      updatedInput: { injected: true },
    });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-upd", "MockWrite");
    await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(write.capturedInputs[0]).toEqual({ injected: true });
  });

  it("tool_call_start.input reflects the updatedInput rewrite", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({
      behavior: "allow",
      updatedInput: { injected: true },
    });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-upd-evt", "MockWrite", { original: true });
    const { events } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const start = events.find(e => e.type === "tool_call_start") as ToolCallStartEvent;
    expect(start).toBeDefined();
    // Canonical input reported in the start event must be the rewritten input,
    // matching what execute() actually received — not the model's raw input.
    expect(start.input).toEqual({ injected: true });
  });
});

// ---------------------------------------------------------------------------
// Test: permission_request emitted BEFORE canUseTool is invoked
// ---------------------------------------------------------------------------

describe("scheduler — permission_request precedes canUseTool invocation", () => {
  it("yields PermissionRequestEvent before the callback runs", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    let canUseToolCalled = false;
    const canUseTool: CanUseTool = async () => {
      canUseToolCalled = true;
      return { behavior: "allow" };
    };

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-pre", "MockWrite");
    const gen = executeToolCalls([block], ai, si, neverSignal());

    let sawPermReq = false;
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      if (next.value.type === "permission_request") {
        sawPermReq = true;
        // At the moment the event surfaces, the callback must not have run yet —
        // the generator is suspended at the yield, before resolve() awaits it.
        expect(canUseToolCalled).toBe(false);
      }
    }

    expect(sawPermReq).toBe(true);
    expect(canUseToolCalled).toBe(true); // callback is eventually invoked
  });
});

// ---------------------------------------------------------------------------
// Test: Tool execute throws non-AbortError
// ---------------------------------------------------------------------------

describe("scheduler — tool throws non-AbortError", () => {
  it("synthesizes is_error 'Tool failed: <msg>' without propagating", async () => {
    const fail = new MockAlwaysFailTool("intentional failure");
    const tools = new ToolRegistry();
    tools.register(fail);

    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-fail", "MockAlwaysFail");
    const { results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool failed: intentional failure");
  });
});

// ---------------------------------------------------------------------------
// Test: All reads — parallel execution, results in original order
// ---------------------------------------------------------------------------

describe("scheduler — all reads (parallel)", () => {
  it("runs 3 reads in parallel; results in original order; start precedes end per id", async () => {
    const r0 = new MockReadTool("result-0");
    const r1 = new MockReadTool("result-1");
    const r2 = new MockReadTool("result-2");

    Object.defineProperty(r0, "name", { value: "Read0", writable: false });
    Object.defineProperty(r1, "name", { value: "Read1", writable: false });
    Object.defineProperty(r2, "name", { value: "Read2", writable: false });

    const tools = new ToolRegistry();
    tools.register(r0);
    tools.register(r1);
    tools.register(r2);

    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-0", "Read0"),
      makeToolUseBlock("tu-1", "Read1"),
      makeToolUseBlock("tu-2", "Read2"),
    ];

    // Resolve in reverse order: r2 first, then r1, then r0
    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));

    await new Promise(r => setTimeout(r, 10));
    r2.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r1.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r0.deferred.resolve();

    const { events, results } = await genProm;

    // Results in original block order (not completion order)
    expect(results).toHaveLength(3);
    expect(results[0]!.tool_use_id).toBe("tu-0");
    expect(results[1]!.tool_use_id).toBe("tu-1");
    expect(results[2]!.tool_use_id).toBe("tu-2");

    expect(results[0]!.content).toBe("result-0");
    expect(results[1]!.content).toBe("result-1");
    expect(results[2]!.content).toBe("result-2");

    // For each tool_use_id, its start precedes its end
    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);

    for (const start of starts) {
      const sIdx = events.indexOf(start);
      const end = ends.find(e => e.tool_use_id === start.tool_use_id);
      expect(end).toBeDefined();
      const eIdx = events.indexOf(end!);
      expect(sIdx).toBeLessThan(eIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Mixed reads + writes — adjacent-batch partitioning preserves call order
// ---------------------------------------------------------------------------

describe("scheduler — mixed reads + writes (adjacent-batch partitioning)", () => {
  it("events appear in batch order; writes (non-parallelSafe) serialize between read batches", async () => {
    const read0 = new MockReadTool("read-result-0");
    const read1 = new MockReadTool("read-result-1");
    const write0 = new MockWriteTool("write-result-0");
    const write1 = new MockWriteTool("write-result-1");

    Object.defineProperty(read0, "name", { value: "MixRead0", writable: false });
    Object.defineProperty(read1, "name", { value: "MixRead1", writable: false });
    Object.defineProperty(write0, "name", { value: "MixWrite0", writable: false });
    Object.defineProperty(write1, "name", { value: "MixWrite1", writable: false });

    const tools = new ToolRegistry();
    tools.register(read0);
    tools.register(read1);
    tools.register(write0);
    tools.register(write1);

    const { ai, si } = await makeInternals({ tools });

    // Interleaved: read0, write0, read1, write1 (original order)
    const blocks = [
      makeToolUseBlock("tu-r0", "MixRead0"),
      makeToolUseBlock("tu-w0", "MixWrite0"),
      makeToolUseBlock("tu-r1", "MixRead1"),
      makeToolUseBlock("tu-w1", "MixWrite1"),
    ];

    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    await new Promise(r => setTimeout(r, 5));
    read0.deferred.resolve();
    read1.deferred.resolve();

    const { events, results } = await genProm;

    // Results in original block order
    expect(results[0]!.tool_use_id).toBe("tu-r0");
    expect(results[1]!.tool_use_id).toBe("tu-w0");
    expect(results[2]!.tool_use_id).toBe("tu-r1");
    expect(results[3]!.tool_use_id).toBe("tu-w1");

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    // After the parallelSafe-based refactor, [Read, Write, Read, Write] becomes
    // four batches: par(Read0), ser(Write0), par(Read1), ser(Write1). Events
    // appear in batch order: tu-r0 ends before tu-w0 starts; tu-w0 ends before
    // tu-r1 starts; tu-r1 ends before tu-w1 starts.
    const idx = (id: string, kind: "start" | "end"): number => {
      const arr = kind === "start" ? starts : ends;
      const ev = arr.find(e => e.tool_use_id === id)!;
      return events.indexOf(ev);
    };

    expect(idx("tu-r0", "end")).toBeLessThan(idx("tu-w0", "start"));
    expect(idx("tu-w0", "end")).toBeLessThan(idx("tu-r1", "start"));
    expect(idx("tu-r1", "end")).toBeLessThan(idx("tu-w1", "start"));

    // Per-tool start precedes end.
    for (const id of ["tu-r0", "tu-w0", "tu-r1", "tu-w1"]) {
      expect(idx(id, "start")).toBeLessThan(idx(id, "end"));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Abort between sequential writes
// ---------------------------------------------------------------------------

describe("scheduler — abort between sequential writes", () => {
  it("second write does not start after first completes and signal is aborted", async () => {
    const write0 = new MockWriteTool();
    const abortAware = new MockAbortAwareTool();

    Object.defineProperty(write0, "name", { value: "AbortWrite0", writable: false });

    const tools = new ToolRegistry();
    tools.register(write0);
    tools.register(abortAware);

    const { ai, si } = await makeInternals({ tools });

    const controller = new AbortController();

    const blocks = [
      makeToolUseBlock("tu-aw0", "AbortWrite0"),
      makeToolUseBlock("tu-aa", "MockAbortAware"),
    ];

    // write0 resolves immediately (constructor default), then we abort before MockAbortAware
    const genProm = collectGen(executeToolCalls(blocks, ai, si, controller.signal));

    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(genProm).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: Multiple asks aggregated into single PermissionRequestEvent
// ---------------------------------------------------------------------------

describe("scheduler — multiple asks aggregated", () => {
  it("emits one PermissionRequestEvent with all ask requests", async () => {
    const write0 = new MockWriteTool();
    const write1 = new MockWriteTool();

    Object.defineProperty(write0, "name", { value: "MultiAsk0", writable: false });
    Object.defineProperty(write1, "name", { value: "MultiAsk1", writable: false });

    const tools = new ToolRegistry();
    tools.register(write0);
    tools.register(write1);

    const canUseTool: CanUseTool = async () => ({ behavior: "allow" });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });

    const blocks = [
      makeToolUseBlock("tu-ma0", "MultiAsk0"),
      makeToolUseBlock("tu-ma1", "MultiAsk1"),
    ];

    const { events } = await collectGen(executeToolCalls(blocks, ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0]!.requests).toHaveLength(2);

    const ids = permReqs[0]!.requests.map(r => r.tool_use_id);
    expect(ids).toContain("tu-ma0");
    expect(ids).toContain("tu-ma1");

    // PermissionRequestEvent must precede all tool_call_start events
    const permIdx = events.findIndex(e => e.type === "permission_request");
    const firstStartIdx = events.findIndex(e => e.type === "tool_call_start");
    expect(permIdx).toBeLessThan(firstStartIdx);
  });
});

// ---------------------------------------------------------------------------
// Test: No PermissionRequestEvent when no asks
// ---------------------------------------------------------------------------

describe("scheduler — no asks in yolo mode", () => {
  it("does not emit PermissionRequestEvent when all tools allowed without asking", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const { ai, si } = await makeInternals({ tools, permMode: "yolo" });
    const block = makeToolUseBlock("tu-yolo", "MockWrite");
    const { events } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request");
    expect(permReqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Empty blocks array
// ---------------------------------------------------------------------------

describe("scheduler — empty blocks", () => {
  it("returns empty results with no events when blocks is empty", async () => {
    const { ai, si } = await makeInternals();
    const { events, results } = await collectGen(executeToolCalls([], ai, si, neverSignal()));
    expect(events).toHaveLength(0);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Already-aborted signal with sequential writes
// ---------------------------------------------------------------------------

describe("scheduler — pre-aborted signal with sequential write", () => {
  it("throws AbortError immediately when signal is already aborted (sequential writes)", async () => {
    const write = new MockWriteTool();
    const write2 = new MockWriteTool();

    Object.defineProperty(write, "name", { value: "PAbort0", writable: false });
    Object.defineProperty(write2, "name", { value: "PAbort1", writable: false });

    const tools = new ToolRegistry();
    tools.register(write);
    tools.register(write2);

    const { ai, si } = await makeInternals({ tools });
    const signal = makeAbortedSignal();

    const blocks = [
      makeToolUseBlock("tu-pa0", "PAbort0"),
      makeToolUseBlock("tu-pa1", "PAbort1"),
    ];

    await expect(collectGen(executeToolCalls(blocks, ai, si, signal))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: abort during parallel reads emits tool_call_end with is_error before propagating
// ---------------------------------------------------------------------------

describe("scheduler — abort during parallel reads emits tool_call_end before propagating", () => {
  it("both tool_call_end events (is_error:true) are yielded before AbortError escapes", async () => {
    const read0 = new MockAbortAwareReadTool();
    const read1 = new MockAbortAwareReadTool();

    Object.defineProperty(read0, "name", { value: "AbortRead0", writable: false });
    Object.defineProperty(read1, "name", { value: "AbortRead1", writable: false });

    const tools = new ToolRegistry();
    tools.register(read0);
    tools.register(read1);

    const { ai, si } = await makeInternals({ tools });
    const controller = new AbortController();

    const blocks = [
      makeToolUseBlock("tu-ar0", "AbortRead0"),
      makeToolUseBlock("tu-ar1", "AbortRead1"),
    ];

    const gen = executeToolCalls(blocks, ai, si, controller.signal);
    const events: Event[] = [];

    // Collect events and catch the expected AbortError
    const drainPromise = (async () => {
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
      }
    })();

    // Let the reads start, then abort
    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(drainPromise).rejects.toThrow();

    // Both tool_call_start and tool_call_end must be in the emitted events
    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    // Both reads should have started
    expect(starts).toHaveLength(2);
    // Both reads should have emitted tool_call_end with is_error: true
    expect(ends).toHaveLength(2);
    for (const end of ends) {
      expect(end.is_error).toBe(true);
    }

    // Each start precedes its matching end
    for (const start of starts) {
      const sIdx = events.indexOf(start);
      const end = ends.find(e => e.tool_use_id === start.tool_use_id);
      expect(end).toBeDefined();
      const eIdx = events.indexOf(end!);
      expect(sIdx).toBeLessThan(eIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: abort during sequential write emits tool_call_end with is_error before propagating
// ---------------------------------------------------------------------------

describe("scheduler — abort during sequential write emits tool_call_end before propagating", () => {
  it("tool_call_end { is_error: true } is yielded before AbortError escapes", async () => {
    const abortAware = new MockAbortAwareTool();
    const tools = new ToolRegistry();
    tools.register(abortAware);

    const { ai, si } = await makeInternals({ tools });
    const controller = new AbortController();

    const blocks = [makeToolUseBlock("tu-aw", "MockAbortAware")];

    const gen = executeToolCalls(blocks, ai, si, controller.signal);
    const events: Event[] = [];

    const drainPromise = (async () => {
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
      }
    })();

    // Let the write start executing, then abort
    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(drainPromise).rejects.toThrow();

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.is_error).toBe(true);
    expect(ends[0]!.tool_use_id).toBe("tu-aw");

    // start precedes end in event order
    const sIdx = events.indexOf(starts[0]!);
    const eIdx = events.indexOf(ends[0]!);
    expect(sIdx).toBeLessThan(eIdx);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (subagent-followup): adjacent-batch partitioning by parallelSafe
// ---------------------------------------------------------------------------

import type { Tool, ToolContext, ToolResult } from "../tools/base.js";

class BarrierTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = "test barrier tool";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  constructor(name: string, private readonly arrived: () => void, private readonly waiter: Promise<void>) {
    this.name = name;
  }
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return this.name; }
  async execute(_input: Record<string, unknown>): Promise<ToolResult> {
    this.arrived();
    await this.waiter;
    return { content: "ok", summary: this.name };
  }
}

class CountingParallelTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = "counts concurrent execution";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  constructor(name: string, private readonly counter: { current: number; max: number }) {
    this.name = name;
  }
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return this.name; }
  async execute(_input: Record<string, unknown>): Promise<ToolResult> {
    this.counter.current++;
    if (this.counter.current > this.counter.max) this.counter.max = this.counter.current;
    await new Promise((r) => setTimeout(r, 8));
    this.counter.current--;
    return { content: "ok", summary: this.name };
  }
}

class EmittingParallelTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = "emits ctx events from parallel lane";
  readonly scope = "exec" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  constructor(name: string, private readonly token: string) { this.name = name; }
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return this.name; }
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    ctx.emit?.({
      type: "subagent_event",
      parent_session_id: "p",
      subagent_run_id: this.token,
      subagent_type: "test",
      display_name: "t",
      event: { type: "system", model: "m", tools: [], permissionMode: "yolo", subagentMode: false },
    });
    return { content: "ok", summary: this.name };
  }
}

/**
 * Emits a burst of ctx events on start, then parks until abort and rejects with
 * AbortError. Used to leave sibling generators suspended mid-iteration (parked
 * at yield with buffered events) when one sibling's abort tears down the batch.
 */
class EmitHeavyAbortTool implements Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description = "emits a burst then aborts";
  readonly scope = "exec" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  constructor(name: string, private readonly token: string, private readonly burst: number) {
    this.name = name;
  }
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return this.name; }
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    for (let i = 0; i < this.burst; i++) {
      ctx.emit?.({
        type: "subagent_event",
        parent_session_id: "p",
        subagent_run_id: `${this.token}-${i}`,
        subagent_type: "test",
        display_name: "t",
        event: { type: "system", model: "m", tools: [], permissionMode: "yolo", subagentMode: false },
      });
    }
    await new Promise<void>((_resolve, reject) => {
      if (ctx.signal.aborted) { reject(new AbortError("aborted")); return; }
      ctx.signal.addEventListener("abort", () => reject(new AbortError("aborted")), { once: true });
    });
    return { content: "ok", summary: this.name };
  }
}

describe("scheduler — abort in parallel emit-heavy batch (no unhandled rejection)", () => {
  it("abandoned siblings with buffered events do not produce unhandled rejections", async () => {
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown) => captured.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Asymmetric batch: a fast "aborter" with no buffered events reaches its
      // throw first, tearing down the batch while the two heavy emitters still
      // have a large backlog buffered — i.e. siblings parked at `yield`. Pre-fix
      // their rejected runPromises were never awaited → unhandled rejections.
      const aborter = new EmitHeavyAbortTool("EmitAbortA", "ea", 0);
      const heavy1 = new EmitHeavyAbortTool("EmitAbortB", "eb", 100);
      const heavy2 = new EmitHeavyAbortTool("EmitAbortC", "ec", 100);
      const tools = new ToolRegistry();
      tools.register(aborter); tools.register(heavy1); tools.register(heavy2);
      const { ai, si } = await makeInternals({ tools });

      const controller = new AbortController();
      const blocks = [
        makeToolUseBlock("tu-a", "EmitAbortA"),
        makeToolUseBlock("tu-b", "EmitAbortB"),
        makeToolUseBlock("tu-c", "EmitAbortC"),
      ];
      const gen = executeToolCalls(blocks, ai, si, controller.signal);

      // Pull a few events so the heavy emitters are mid-stream with a backlog.
      for (let i = 0; i < 5; i++) {
        if ((await gen.next()).done) break;
      }

      // Abort while a large backlog remains buffered in the heavy emitters.
      controller.abort();

      // Drain the rest; the batch ultimately throws AbortError.
      try {
        while (!(await gen.next()).done) { /* consume */ }
      } catch {
        // expected AbortError
      }

      // Give any leaked rejection a chance to surface.
      await new Promise(r => setTimeout(r, 40));

      const abortRejections = captured.filter(r => r instanceof AbortError);
      expect(abortRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("scheduler — adjacent-batch partitioning", () => {
  it("[Read, Read, Write, Read] yields three batches with reads grouped only when adjacent", async () => {
    const r0 = new MockReadTool("r0-result");
    const r1 = new MockReadTool("r1-result");
    const r2 = new MockReadTool("r2-result");
    const w0 = new MockWriteTool("w0-result");
    Object.defineProperty(r0, "name", { value: "PartRead0" });
    Object.defineProperty(r1, "name", { value: "PartRead1" });
    Object.defineProperty(r2, "name", { value: "PartRead2" });
    Object.defineProperty(w0, "name", { value: "PartWrite0" });

    const tools = new ToolRegistry();
    tools.register(r0); tools.register(r1); tools.register(r2); tools.register(w0);
    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-r0", "PartRead0"),
      makeToolUseBlock("tu-r1", "PartRead1"),
      makeToolUseBlock("tu-w0", "PartWrite0"),
      makeToolUseBlock("tu-r2", "PartRead2"),
    ];

    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    await new Promise((r) => setTimeout(r, 5));
    r0.deferred.resolve(); r1.deferred.resolve(); r2.deferred.resolve();
    const { events } = await genProm;

    const findIdx = (id: string, kind: "tool_call_start" | "tool_call_end") =>
      events.findIndex((e) => e.type === kind && (e as ToolCallStartEvent | ToolCallEndEvent).tool_use_id === id);

    // r0 + r1 in batch 1 (parallel); w0 in batch 2 (serial); r2 in batch 3 (parallel-of-1).
    // Batches dispatch in order: batch 1 events finish before batch 2 events start, etc.
    expect(findIdx("tu-r0", "tool_call_end")).toBeLessThan(findIdx("tu-w0", "tool_call_start"));
    expect(findIdx("tu-r1", "tool_call_end")).toBeLessThan(findIdx("tu-w0", "tool_call_start"));
    expect(findIdx("tu-w0", "tool_call_end")).toBeLessThan(findIdx("tu-r2", "tool_call_start"));
  });

  it("results are returned in original block order regardless of batch shape", async () => {
    const r0 = new MockReadTool("r0");
    const w0 = new MockWriteTool("w0");
    const r1 = new MockReadTool("r1");
    Object.defineProperty(r0, "name", { value: "OrdRead0" });
    Object.defineProperty(w0, "name", { value: "OrdWrite0" });
    Object.defineProperty(r1, "name", { value: "OrdRead1" });

    const tools = new ToolRegistry();
    tools.register(r0); tools.register(w0); tools.register(r1);
    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-a", "OrdRead0"),
      makeToolUseBlock("tu-b", "OrdWrite0"),
      makeToolUseBlock("tu-c", "OrdRead1"),
    ];
    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    await new Promise((r) => setTimeout(r, 5));
    r0.deferred.resolve(); r1.deferred.resolve();
    const { results } = await genProm;

    expect(results.map((r) => r.tool_use_id)).toEqual(["tu-a", "tu-b", "tu-c"]);
  });
});

describe("scheduler — parallel-lane concurrency proof", () => {
  it("two parallel-safe tools run concurrently (barrier releases both)", async () => {
    let arrivals = 0;
    let release!: () => void;
    const waiter = new Promise<void>((r) => { release = r; });
    const onArrive = () => {
      arrivals++;
      if (arrivals >= 2) release();
    };

    const a = new BarrierTool("BarA", onArrive, waiter);
    const b = new BarrierTool("BarB", onArrive, waiter);
    const tools = new ToolRegistry();
    tools.register(a); tools.register(b);
    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-a", "BarA"),
      makeToolUseBlock("tu-b", "BarB"),
    ];

    const t0 = Date.now();
    const { results } = await collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    const elapsed = Date.now() - t0;

    expect(results).toHaveLength(2);
    expect(arrivals).toBe(2);
    // If sequential, the first would have hung forever and Bun would time out.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("scheduler — concurrency cap enforcement", () => {
  it("at most ai.toolConcurrency parallel-safe tools in flight at once", async () => {
    const counter = { current: 0, max: 0 };
    const tools = new ToolRegistry();
    const blocks: ToolUseBlock[] = [];
    for (let i = 0; i < 8; i++) {
      const name = `CountTool${i}`;
      const t = new CountingParallelTool(name, counter);
      tools.register(t);
      blocks.push(makeToolUseBlock(`tu-${i}`, name));
    }
    const { ai, si } = await makeInternals({ tools });
    ai.toolConcurrency = 3; // override the agent's default 10 for this test

    await collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    expect(counter.max).toBeLessThanOrEqual(3);
    expect(counter.max).toBeGreaterThanOrEqual(2); // at least some concurrency
  });
});

describe("scheduler — abort orphan-bracket synthesis", () => {
  it("every started tool_use_id receives tool_call_end after abort in a parallel batch", async () => {
    // Three abort-aware reads in one parallel batch. Abort triggers AbortError
    // in each. The throwing tool emits its own tool_call_end; siblings'
    // generators are abandoned, but the scheduler synthesizes their close-brackets.
    const r1 = new MockAbortAwareReadTool();
    const r2 = new MockAbortAwareReadTool();
    const r3 = new MockAbortAwareReadTool();
    Object.defineProperty(r1, "name", { value: "AbortRead1" });
    Object.defineProperty(r2, "name", { value: "AbortRead2" });
    Object.defineProperty(r3, "name", { value: "AbortRead3" });

    const tools = new ToolRegistry();
    tools.register(r1); tools.register(r2); tools.register(r3);
    const { ai, si } = await makeInternals({ tools });

    const controller = new AbortController();
    const blocks = [
      makeToolUseBlock("tu-1", "AbortRead1"),
      makeToolUseBlock("tu-2", "AbortRead2"),
      makeToolUseBlock("tu-3", "AbortRead3"),
    ];

    const gen = executeToolCalls(blocks, ai, si, controller.signal);
    const events: Event[] = [];
    const drainProm = (async () => {
      try {
        while (true) {
          const next = await gen.next();
          if (next.done) break;
          events.push(next.value);
        }
      } catch {
        // AbortError swallowed; we assert on events below.
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await drainProm;

    const starts = events.filter((e) => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter((e) => e.type === "tool_call_end") as ToolCallEndEvent[];

    // Critical invariant: every tool_use_id that emitted a start has a matching end.
    expect(starts.length).toBe(3);
    expect(ends.length).toBe(3);
    const startIds = new Set(starts.map((e) => e.tool_use_id));
    const endIds = new Set(ends.map((e) => e.tool_use_id));
    expect(startIds).toEqual(endIds);

    // All ends carry is_error: true (real or synthetic).
    for (const e of ends) expect(e.is_error).toBe(true);
  });
});

describe("scheduler — parallel-lane ctx.emit wiring", () => {
  it("emit events from concurrent parallel tools interleave in the parent stream", async () => {
    const a = new EmittingParallelTool("EmitA", "sr-A");
    const b = new EmittingParallelTool("EmitB", "sr-B");
    const tools = new ToolRegistry();
    tools.register(a); tools.register(b);
    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-a", "EmitA"),
      makeToolUseBlock("tu-b", "EmitB"),
    ];
    const { events } = await collectGen(executeToolCalls(blocks, ai, si, neverSignal()));

    const subagentEvents = events.filter((e) => e.type === "subagent_event");
    expect(subagentEvents.length).toBe(2);
    // Both run-ids appear (proves both tools' emit reached the parent stream).
    const ids = new Set(subagentEvents.map((e: any) => e.subagent_run_id));
    expect(ids).toEqual(new Set(["sr-A", "sr-B"]));
  });
});
