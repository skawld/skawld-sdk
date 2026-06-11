/**
 * Integration tests for the full engine: Agent → Session → runLoop → scheduler.
 * Tests are end-to-end: each drives a session.run() and asserts the event sequence.
 */

import { describe, test, expect } from "bun:test";
import { Agent } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import { MockReadTool, MockWriteTool } from "./_test-mock-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { ProviderError, ContextLengthError } from "./errors.js";
import type { Event } from "./events.js";
import type { CompactionStrategy } from "./compaction.js";
import type { CanUseTool } from "../permissions/engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Build a minimal text-turn script with configurable text and usage. */
function textTurnScript(text = "hello", inputTokens = 10, outputTokens = 5) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      },
    ],
  };
}

/** Build a tool_use turn script with one tool block. */
function toolUseTurnScript(toolUseId: string, toolName: string, inputJson = "{}") {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "tool_use_start" as const, id: toolUseId, name: toolName },
      { type: "tool_use_input_delta" as const, id: toolUseId, json_delta: inputJson },
      { type: "tool_use_end" as const, id: toolUseId },
      {
        type: "message_end" as const,
        stop_reason: "tool_use" as const,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      },
    ],
  };
}

/** Minimal Agent with MockProvider + InMemorySessionStore. */
function makeAgent(
  provider: MockProvider,
  opts?: {
    tools?: ToolRegistry;
    permMode?: "default" | "yolo";
    canUseTool?: CanUseTool;
    maxOutputTokens?: number;
    compaction?: CompactionStrategy;
  },
) {
  return new Agent({
    provider,
    model: "test-model",
    sessionStore: new InMemorySessionStore(),
    tools: opts?.tools,
    permissions: {
      mode: opts?.permMode ?? "yolo",
      canUseTool: opts?.canUseTool,
    },
    maxOutputTokens: opts?.maxOutputTokens ?? 8192,
    compaction: opts?.compaction,
  });
}

// ---------------------------------------------------------------------------
// a. Simple text turn (no tools)
// ---------------------------------------------------------------------------

describe("integration — simple text turn", () => {
  test("event sequence: system → user → assistant → usage → result(success)", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurnScript("hi"));
    const agent = makeAgent(provider);
    const sess = await agent.session();

    const events = await collectEvents(sess.run("hello"));
    const types = events.map(e => e.type);

    expect(types).toEqual(["system", "user", "assistant", "usage", "result"]);

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");
    expect(result.stop_reason).toBe("end_turn");

    const asst = events.find(e => e.type === "assistant") as Extract<Event, { type: "assistant" }>;
    const textBlock = asst.message.content.find(b => b.type === "text");
    expect((textBlock as { text: string }).text).toBe("hi");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// b. Single tool call round trip
// ---------------------------------------------------------------------------

describe("integration — single tool call round trip", () => {
  test("turn 1 tool_use → tool executes → turn 2 end_turn; correct event sequence", async () => {
    const read = new MockReadTool("tool output");
    const tools = new ToolRegistry();
    tools.register(read);

    const provider = new MockProvider();
    provider.enqueue(toolUseTurnScript("tu-1", "MockRead"));
    provider.enqueue(textTurnScript("done"));

    const agent = makeAgent(provider, { tools });
    const sess = await agent.session();

    // Resolve the read immediately when it starts
    const eventsPromise = collectEvents(sess.run("do something"));
    await new Promise(r => setTimeout(r, 10));
    read.deferred.resolve();

    const events = await eventsPromise;
    const types = events.map(e => e.type);

    // system → user → assistant(turn1) → usage → tool_call_start → tool_call_end
    //   → user(tool_result) → assistant(turn2) → usage → result(success)
    expect(types).toContain("system");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");

    const systemIdx = types.indexOf("system");
    const firstUserIdx = types.indexOf("user");
    const firstAsstIdx = types.indexOf("assistant");
    const firstUsageIdx = types.indexOf("usage");
    const startIdx = types.indexOf("tool_call_start");
    const endIdx = types.indexOf("tool_call_end");
    const lastUserIdx = types.lastIndexOf("user");
    const lastAsstIdx = types.lastIndexOf("assistant");
    const resultIdx = types.lastIndexOf("result");

    expect(systemIdx).toBeLessThan(firstUserIdx);
    expect(firstUserIdx).toBeLessThan(firstAsstIdx);
    expect(firstAsstIdx).toBeLessThan(firstUsageIdx);
    expect(firstUsageIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(endIdx);
    expect(endIdx).toBeLessThan(lastUserIdx);
    expect(lastUserIdx).toBeLessThan(lastAsstIdx);
    expect(lastAsstIdx).toBeLessThan(resultIdx);

    const result = events[resultIdx] as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// c. Multiple parallel reads
// ---------------------------------------------------------------------------

describe("integration — multiple parallel reads", () => {
  test("3 parallel reads: each start precedes its end; all read events precede turn 2 assistant", async () => {
    // Give each a unique name by wrapping in a subclass
    class Read1 extends MockReadTool { override readonly name: string = "MockRead1"; }
    class Read2 extends MockReadTool { override readonly name: string = "MockRead2"; }
    class Read3 extends MockReadTool { override readonly name: string = "MockRead3"; }

    const r1 = new Read1("r1");
    const r2 = new Read2("r2");
    const r3 = new Read3("r3");

    const tools = new ToolRegistry();
    tools.register(r1);
    tools.register(r2);
    tools.register(r3);

    const provider = new MockProvider();
    // Turn 1: 3 parallel reads
    provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "tool_use_start" as const, id: "tu-r1", name: "MockRead1" },
        { type: "tool_use_input_delta" as const, id: "tu-r1", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-r1" },
        { type: "tool_use_start" as const, id: "tu-r2", name: "MockRead2" },
        { type: "tool_use_input_delta" as const, id: "tu-r2", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-r2" },
        { type: "tool_use_start" as const, id: "tu-r3", name: "MockRead3" },
        { type: "tool_use_input_delta" as const, id: "tu-r3", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-r3" },
        {
          type: "message_end" as const,
          stop_reason: "tool_use" as const,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });
    // Turn 2: end_turn
    provider.enqueue(textTurnScript("all reads done"));

    const agent = makeAgent(provider, { tools });
    const sess = await agent.session();

    const eventsPromise = collectEvents(sess.run("read three files"));

    // Resolve in scrambled order: r3, r1, r2
    await new Promise(r => setTimeout(r, 10));
    r3.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r1.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r2.deferred.resolve();

    const events = await eventsPromise;

    // Count tool_call_start and tool_call_end events
    const starts = events.filter(e => e.type === "tool_call_start") as Array<Extract<Event, { type: "tool_call_start" }>>;
    const ends = events.filter(e => e.type === "tool_call_end") as Array<Extract<Event, { type: "tool_call_end" }>>;
    expect(starts.length).toBe(3);
    expect(ends.length).toBe(3);

    // For each id, start must precede end
    for (const id of ["tu-r1", "tu-r2", "tu-r3"]) {
      const startEvIdx = events.findIndex(
        e => e.type === "tool_call_start" &&
        (e as Extract<Event, { type: "tool_call_start" }>).tool_use_id === id,
      );
      const endEvIdx = events.findIndex(
        e => e.type === "tool_call_end" &&
        (e as Extract<Event, { type: "tool_call_end" }>).tool_use_id === id,
      );
      expect(startEvIdx).toBeGreaterThanOrEqual(0);
      expect(endEvIdx).toBeGreaterThanOrEqual(0);
      expect(startEvIdx).toBeLessThan(endEvIdx);
    }

    // All read events (starts + ends) must precede the 2nd assistant event (turn 2)
    const allToolIndices = [
      ...events.map((e, i) => e.type === "tool_call_start" || e.type === "tool_call_end" ? i : -1),
    ].filter(i => i >= 0);
    const lastToolIdx = Math.max(...allToolIndices);

    const asstEvents = events.map((e, i) => e.type === "assistant" ? i : -1).filter(i => i >= 0);
    expect(asstEvents.length).toBe(2); // turn1 + turn2
    const turn2AsstIdx = asstEvents[1]!;
    expect(lastToolIdx).toBeLessThan(turn2AsstIdx);

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// d. Mixed read + write
// ---------------------------------------------------------------------------

describe("integration — mixed read + write", () => {
  test("adjacent-batch partitioning preserves arrival order across mixed read/write batches", async () => {
    class Read1 extends MockReadTool { override readonly name: string = "MixRead1"; }
    class Read2 extends MockReadTool { override readonly name: string = "MixRead2"; }
    class Write1 extends MockWriteTool { override readonly name: string = "MixWrite1"; }
    class Write2 extends MockWriteTool { override readonly name: string = "MixWrite2"; }

    const r1 = new Read1("r1");
    const r2 = new Read2("r2");
    const w1 = new Write1("w1");
    const w2 = new Write2("w2");

    const tools = new ToolRegistry();
    tools.register(r1);
    tools.register(r2);
    tools.register(w1);
    tools.register(w2);

    const provider = new MockProvider();
    // Turn 1: 2 reads + 2 writes in mixed order
    provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "tool_use_start" as const, id: "tu-mr1", name: "MixRead1" },
        { type: "tool_use_input_delta" as const, id: "tu-mr1", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-mr1" },
        { type: "tool_use_start" as const, id: "tu-mw1", name: "MixWrite1" },
        { type: "tool_use_input_delta" as const, id: "tu-mw1", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-mw1" },
        { type: "tool_use_start" as const, id: "tu-mr2", name: "MixRead2" },
        { type: "tool_use_input_delta" as const, id: "tu-mr2", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-mr2" },
        { type: "tool_use_start" as const, id: "tu-mw2", name: "MixWrite2" },
        { type: "tool_use_input_delta" as const, id: "tu-mw2", json_delta: "{}" },
        { type: "tool_use_end" as const, id: "tu-mw2" },
        {
          type: "message_end" as const,
          stop_reason: "tool_use" as const,
          usage: { input_tokens: 15, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });
    provider.enqueue(textTurnScript("done"));

    const agent = makeAgent(provider, { tools });
    const sess = await agent.session();

    const eventsPromise = collectEvents(sess.run("mixed tools"));

    // Unblock reads immediately; writes resolve on their own (default: immediate)
    await new Promise(r => setTimeout(r, 10));
    r1.deferred.resolve();
    r2.deferred.resolve();

    const events = await eventsPromise;

    const starts = events.filter(e => e.type === "tool_call_start") as Array<Extract<Event, { type: "tool_call_start" }>>;
    const ends = events.filter(e => e.type === "tool_call_end") as Array<Extract<Event, { type: "tool_call_end" }>>;
    expect(starts.length).toBe(4);
    expect(ends.length).toBe(4);

    // Arrival order was [r1, w1, r2, w2] → 4 adjacent batches (par/ser/par/ser).
    // Events appear in batch order: each batch's events precede the next batch's.
    const findIdx = (id: string, kind: "tool_call_start" | "tool_call_end"): number =>
      events.findIndex(e => e.type === kind && (e as Extract<Event, { type: typeof kind }>).tool_use_id === id);

    expect(findIdx("tu-mr1", "tool_call_end")).toBeLessThan(findIdx("tu-mw1", "tool_call_start"));
    expect(findIdx("tu-mw1", "tool_call_end")).toBeLessThan(findIdx("tu-mr2", "tool_call_start"));
    expect(findIdx("tu-mr2", "tool_call_end")).toBeLessThan(findIdx("tu-mw2", "tool_call_start"));

    // Per-tool: start precedes end.
    for (const id of ["tu-mr1", "tu-mw1", "tu-mr2", "tu-mw2"]) {
      expect(findIdx(id, "tool_call_start")).toBeLessThan(findIdx(id, "tool_call_end"));
    }

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// e. Permission ask → allow
// ---------------------------------------------------------------------------

describe("integration — permission ask → allow", () => {
  test("emits exactly one permission_request before tool_call_start; tool runs successfully", async () => {
    const write = new MockWriteTool("written");
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async (_req, _signal) => ({ behavior: "allow" });

    const provider = new MockProvider();
    provider.enqueue(toolUseTurnScript("tu-perm-allow", "MockWrite"));
    provider.enqueue(textTurnScript("ok"));

    // mode "default" causes write tools to "ask"
    const agent = makeAgent(provider, { tools, permMode: "default", canUseTool });
    const sess = await agent.session();

    const events = await collectEvents(sess.run("write it"));
    const types = events.map(e => e.type);

    const permReqs = events.filter(e => e.type === "permission_request");
    expect(permReqs.length).toBe(1);

    // permission_request must precede tool_call_start
    const permIdx = types.indexOf("permission_request");
    const startIdx = types.indexOf("tool_call_start");
    expect(permIdx).toBeLessThan(startIdx);

    // tool_call_end must not be an error
    const endEv = events.find(e => e.type === "tool_call_end") as Extract<Event, { type: "tool_call_end" }>;
    expect(endEv.is_error).toBe(false);

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// f. Permission ask → deny
// ---------------------------------------------------------------------------

describe("integration — permission ask → deny", () => {
  test("emits permission_request then tool_call_end(is_error=true) with deny message", async () => {
    const write = new MockWriteTool("should not run");
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async (_req, _signal) => ({
      behavior: "deny",
      message: "nope",
    });

    const provider = new MockProvider();
    provider.enqueue(toolUseTurnScript("tu-perm-deny", "MockWrite"));
    provider.enqueue(textTurnScript("finished"));

    const agent = makeAgent(provider, { tools, permMode: "default", canUseTool });
    const sess = await agent.session();

    const events = await collectEvents(sess.run("write it"));
    const types = events.map(e => e.type);

    const permReqs = events.filter(e => e.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const permIdx = types.indexOf("permission_request");
    const startIdx = types.indexOf("tool_call_start");
    expect(permIdx).toBeLessThan(startIdx);

    const endEv = events.find(e => e.type === "tool_call_end") as Extract<Event, { type: "tool_call_end" }>;
    expect(endEv.is_error).toBe(true);

    // Tool result message must contain the deny reason
    const userEvents = events.filter(e => e.type === "user") as Array<Extract<Event, { type: "user" }>>;
    const toolResultUser = userEvents[userEvents.length - 1]!;
    const toolResultBlock = toolResultUser.message.content.find(b => b.type === "tool_result") as
      { type: "tool_result"; content: string; is_error?: boolean } | undefined;
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.content).toContain("Tool call denied: nope");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// g. Abort mid-stream
// ---------------------------------------------------------------------------

describe("integration — abort mid-stream", () => {
  test("result(aborted) emitted when session.abort() called while stream is paused", async () => {
    const provider = new MockProvider();
    const deferred = provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "text_delta" as const, text: "partial" },
        { type: "text_delta" as const, text: "more" },  // holdAt: pause here
        {
          type: "message_end" as const,
          stop_reason: "end_turn" as const,
          usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
      holdAt: 2,  // pause before the second text_delta
    });

    const agent = makeAgent(provider);
    const sess = await agent.session();

    const eventsPromise = collectEvents(sess.run("hi"));

    // Wait until stream is paused at holdAt
    await new Promise(r => setTimeout(r, 20));
    sess.abort();
    deferred.resolve();  // unblock so the abort check can fire

    const events = await eventsPromise;
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("aborted");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// h. Compaction trigger (80% threshold)
// ---------------------------------------------------------------------------

describe("integration — compaction trigger", () => {
  test("CompactionEvent emitted before assistant event on turn 2 when 80% threshold exceeded", async () => {
    // MockProvider default contextWindow = 200_000. maxOutputTokens = 100.
    // Turn 1 reports input_tokens = 900. Projected for turn 2: 900+100 = 1000.
    // With contextWindow=1000, threshold = 0.8*1000 = 800. 1000 >= 800 → compact.
    const smallWindowProvider = new (class extends MockProvider {
      override contextWindow(_model: string): number {
        return 1000;
      }
    })();

    const noopStrategy: CompactionStrategy = {
      id: "noop-threshold-test",
      async compact({ messages }) {
        return messages.slice(-1).length > 0 ? messages.slice(-1) : messages;
      },
    };

    smallWindowProvider.enqueue(textTurnScript("first run", 900, 50));
    smallWindowProvider.enqueue(textTurnScript("second run after compaction", 10, 5));

    const agent = new Agent({
      provider: smallWindowProvider,
      model: "test-model",
      sessionStore: new InMemorySessionStore(),
      maxOutputTokens: 100,
      compaction: noopStrategy,
      permissions: { mode: "yolo" },
    });
    const sess = await agent.session();

    // First run — sets lastUsage
    const events1 = await collectEvents(sess.run("first"));
    const result1 = events1.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result1.subtype).toBe("success");

    // Second run — should trigger compaction
    const events2 = await collectEvents(sess.run("second"));
    const types2 = events2.map(e => e.type);

    expect(types2).toContain("compaction");

    const compIdx = types2.indexOf("compaction");
    const asstIdx = types2.indexOf("assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    const compEv = events2[compIdx] as Extract<Event, { type: "compaction" }>;
    expect(compEv.strategy).toBe("noop-threshold-test");

    const result2 = events2.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result2.subtype).toBe("success");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// i. ContextLengthError recovery
// ---------------------------------------------------------------------------

describe("integration — ContextLengthError recovery", () => {
  test("turn-1 ContextLengthError triggers compaction then retry; ends with success", async () => {
    // The strategy must actually change the view — an unchanged view is a
    // no-op and the ContextLengthError is rethrown instead of retried.
    const noopStrategy: CompactionStrategy = {
      id: "noop-ctx-recovery",
      async compact() {
        return [{ role: "user" as const, content: [{ type: "text" as const, text: "condensed" }] }];
      },
    };

    const provider = new MockProvider();
    // Turn 1: throws ContextLengthError immediately
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long"),
    });
    // Retry after compaction: succeeds
    provider.enqueue(textTurnScript("recovered"));

    const agent = makeAgent(provider, { compaction: noopStrategy });
    const sess = await agent.session();

    const events = await collectEvents(sess.run("hi"));
    const types = events.map(e => e.type);

    // Must contain compaction
    expect(types).toContain("compaction");

    // Compaction before assistant
    const compIdx = types.indexOf("compaction");
    const asstIdx = types.indexOf("assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    // Result is success
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    // Assistant has recovered text
    const asst = events.find(e => e.type === "assistant") as Extract<Event, { type: "assistant" }>;
    const textBlock = asst.message.content.find(b => b.type === "text");
    expect((textBlock as { text: string }).text).toBe("recovered");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// j. Error escape (non-retryable ProviderError)
// ---------------------------------------------------------------------------

describe("integration — error escape", () => {
  test("non-retryable ProviderError emits error event then result(error)", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [],
      throwBefore: new ProviderError("provider blew up", { retryable: false }),
    });

    const agent = makeAgent(provider);
    const sess = await agent.session();

    const events = await collectEvents(sess.run("hi"));
    const types = events.map(e => e.type);

    expect(types).toContain("error");
    expect(types).toContain("result");

    const errorIdx = types.indexOf("error");
    const resultIdx = types.lastIndexOf("result");
    expect(errorIdx).toBeLessThan(resultIdx);

    const errorEv = events[errorIdx] as Extract<Event, { type: "error" }>;
    expect(errorEv.error.name).toBe("ProviderError");
    expect(errorEv.error.retryable).toBe(false);

    const result = events[resultIdx] as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("error");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// k. SDK consumption shape (spec #api-shape)
// ---------------------------------------------------------------------------

describe("integration — SDK consumption shape", () => {
  test("for-await-of over sess.run() compiles and runs without error", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurnScript("hello world"));

    const agent = makeAgent(provider);
    const sess = await agent.session();

    let receivedResult = false;

    for await (const event of sess.run("hello")) {
      switch (event.type) {
        case "assistant":
        case "tool_call_start":
        case "tool_call_end":
        case "permission_request":
        case "usage":
        case "compaction":
          break;
        case "result":
          receivedResult = true;
          break;
        case "error":
          throw new Error(`unexpected error event: ${event.error.message}`);
        case "system":
        case "user":
        case "partial_assistant":
          break;
      }
    }

    expect(receivedResult).toBe(true);

    await agent.close();
  });
});
