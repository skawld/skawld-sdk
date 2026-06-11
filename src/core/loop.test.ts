/** Tests for runLoop (Phase 3). */

import { describe, expect, it } from "bun:test";
import { Agent, getAgentInternals } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import { MockWriteTool, MockReadTool } from "./_test-mock-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { ProviderError, ContextLengthError } from "./errors.js";
import type { Event, CompactionEvent, AssistantEvent, ResultEvent } from "./events.js";
import type { CompactionStrategy } from "./compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(provider: MockProvider, opts?: {
  includePartialMessages?: boolean;
  maxTurns?: number;
}) {
  const store = new InMemorySessionStore();
  return {
    agent: new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      includePartialMessages: opts?.includePartialMessages ?? false,
      maxTurns: opts?.maxTurns ?? 100,
    }),
    store,
  };
}

async function collectEvents(iterable: AsyncIterable<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const ev of iterable) {
    events.push(ev);
  }
  return events;
}

/** A minimal "end_turn" script with one text turn. */
function simpleTextScript(text = "hello") {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLoop — simple text turn", () => {
  it("emits events in order: system → user → assistant → usage → result(success)", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("hello"));
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));

    const types = events.map(e => e.type);
    expect(types).toEqual(["system", "user", "assistant", "usage", "result"]);

    // system event
    const sys = events[0] as Extract<Event, { type: "system" }>;
    expect(sys.type).toBe("system");
    expect(sys.subtype).toBe("init");
    expect(sys.session_id).toBe(session.id);
    expect(sys.model).toBe("test-model");
    expect(typeof sys.run_id).toBe("string");

    // user event
    const user = events[1] as Extract<Event, { type: "user" }>;
    expect(user.type).toBe("user");
    expect(user.message.role).toBe("user");

    // assistant event
    const asst = events[2] as Extract<Event, { type: "assistant" }>;
    expect(asst.type).toBe("assistant");
    expect(asst.stop_reason).toBe("end_turn");
    const textBlock = asst.message.content.find(b => b.type === "text");
    expect(textBlock).toBeDefined();
    expect((textBlock as { text: string }).text).toBe("hello");

    // usage event
    const usage = events[3] as Extract<Event, { type: "usage" }>;
    expect(usage.type).toBe("usage");
    expect(usage.usage.input_tokens).toBe(10);
    expect(usage.usage.output_tokens).toBe(5);
    expect(usage.cumulative.input_tokens).toBe(10);

    // result event
    const result = events[4] as Extract<Event, { type: "result" }>;
    expect(result.type).toBe("result");
    expect(result.subtype).toBe("success");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.final_text).toBe("hello");
    expect(result.total_usage.input_tokens).toBe(10);
    expect(typeof result.duration_ms).toBe("number");

    await agent.close();
  });
});

describe("runLoop — provider metadata and thinking summaries", () => {
  it("preserves provider metadata from message_end on assistant messages and in the store", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "ok" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          provider_metadata: {
            openai_responses: {
              response_id: "resp_1",
              output_items: [{ type: "message", id: "msg_1" }],
            },
          },
        },
      ],
    });
    const { agent, store } = makeAgent(provider);
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));
    const assistant = events.find(e => e.type === "assistant") as AssistantEvent | undefined;
    expect(assistant?.message.provider_metadata?.openai_responses?.response_id).toBe("resp_1");

    const stored = await store.loadMessages(session.id);
    expect(stored[1]?.message.provider_metadata?.openai_responses?.response_id).toBe("resp_1");

    await agent.close();
  });

  it("passes prior assistant provider metadata in the next provider request", async () => {
    const requests: import("../providers/base.js").ProviderRequest[] = [];
    let turn = 0;
    const provider: import("../providers/base.js").BaseProvider = {
      id: "metadata-capture",
      contextWindow: () => 200_000,
      async *stream(req) {
        requests.push(req);
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          provider_metadata:
            turn++ === 0
              ? { openai_responses: { response_id: "resp_1" } }
              : undefined,
        };
      },
    };
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "m", sessionStore: store });
    const session = await agent.session();

    await collectEvents(session.run("first"));
    await collectEvents(session.run("second"));

    const previousAssistant = requests[1]?.messages.find(
      (m) => m.role === "assistant" && m.provider_metadata?.openai_responses?.response_id === "resp_1",
    );
    expect(previousAssistant).toBeDefined();

    await agent.close();
  });

  it("assembles reasoning summary deltas into a displayable ThinkingBlock", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "thinking_delta", text: "hmm" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));
    const assistant = events.find(e => e.type === "assistant") as AssistantEvent | undefined;
    expect(assistant?.message.content).toContainEqual({ type: "thinking", thinking: "hmm" });

    await agent.close();
  });
});

describe("runLoop — partial messages", () => {
  it("emits PartialAssistantEvent before AssistantEvent when includePartialMessages=true", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "he" },
        { type: "text_delta", text: "llo" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
    });
    const { agent } = makeAgent(provider, { includePartialMessages: true });
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));

    const partials = events.filter(e => e.type === "partial_assistant");
    expect(partials.length).toBe(2);

    // Partials must come before the assistant event
    const partialIdxs = partials.map(p => events.indexOf(p));
    const asstIdx = events.findIndex(e => e.type === "assistant");
    for (const idx of partialIdxs) {
      expect(idx).toBeLessThan(asstIdx);
    }

    // Check delta content
    const [p1, p2] = partials as Array<Extract<Event, { type: "partial_assistant" }>>;
    expect(p1.delta.kind).toBe("text");
    expect((p1.delta as { text: string }).text).toBe("he");
    expect(p2.delta.kind).toBe("text");
    expect((p2.delta as { text: string }).text).toBe("llo");

    await agent.close();
  });

  it("does NOT emit PartialAssistantEvent when includePartialMessages=false", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "hello" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      ],
    });
    const { agent } = makeAgent(provider, { includePartialMessages: false });
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));

    const partials = events.filter(e => e.type === "partial_assistant");
    expect(partials.length).toBe(0);

    await agent.close();
  });
});

describe("runLoop — abort handling", () => {
  it("abort() while idle does NOT poison the next run — it completes successfully", async () => {
    const provider = new MockProvider();
    // abort() before run() creates a fresh controller in run(), so the idle abort is a no-op.
    provider.enqueue(simpleTextScript("ok"));
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    session.abort(); // idle abort — must not affect the next run

    const events = await collectEvents(session.run("hi"));

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("success");

    await agent.close();
  });

  it("aborts mid-stream and emits result(aborted)", async () => {
    const provider = new MockProvider();

    // enqueue returns the deferred that controls the holdAt pause
    const deferred = provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "first" },
        { type: "text_delta", text: "second" }, // will be blocked at holdAt
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ],
      holdAt: 2, // pause before yielding event at index 2 ("second" text_delta)
    });

    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const eventsPromise = collectEvents(session.run("hi"));

    // Give the stream a moment to reach the holdAt point
    await new Promise<void>(r => setTimeout(r, 20));
    session.abort();
    deferred.resolve(); // unblock the hold so the abort check fires

    const events = await eventsPromise;

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("aborted");

    await agent.close();
  });

  // Regression: run → abort → run again on same session must yield success (not aborted).
  it("regression: run → abort → run again on same session yields success", async () => {
    const provider = new MockProvider();

    // Run 1: hold mid-stream so we can abort it
    const deferred = provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "first" },
        { type: "text_delta", text: "second" },
        { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } },
      ],
      holdAt: 1,
    });

    // Run 2: succeeds normally
    provider.enqueue(simpleTextScript("run2-ok"));

    const { agent } = makeAgent(provider);
    const session = await agent.session();

    // Start run 1 and abort it mid-flight
    const run1Promise = collectEvents(session.run("first prompt"));
    await new Promise<void>(r => setTimeout(r, 10));
    session.abort();
    deferred.resolve();
    const events1 = await run1Promise;

    const result1 = events1.find(e => e.type === "result") as ResultEvent | undefined;
    expect(result1).toBeDefined();
    expect(result1!.subtype).toBe("aborted");

    // Run 2 on the same session must succeed
    const events2 = await collectEvents(session.run("second prompt"));

    const result2 = events2.find(e => e.type === "result") as ResultEvent | undefined;
    expect(result2).toBeDefined();
    expect(result2!.subtype).toBe("success");

    await agent.close();
  });
});

describe("runLoop — provider error", () => {
  it("emits ErrorEvent + ResultEvent(error) when provider throws non-retryable ProviderError", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [],
      throwBefore: new ProviderError("provider blew up", { retryable: false }),
    });
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));

    const errorEvent = events.find(e => e.type === "error") as Extract<Event, { type: "error" }> | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error.name).toBe("ProviderError");
    expect(errorEvent!.error.retryable).toBe(false);

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("error");
    expect(result!.stop_reason).toBe("error");

    await agent.close();
  });
});

describe("runLoop — provider receives correct request", () => {
  it("passes signal and providerView (messages) to provider", async () => {
    let capturedReq: { signal: AbortSignal; messages: unknown } | undefined;

    const capturingProvider: import("../providers/base.js").BaseProvider = {
      id: "capturing",
      contextWindow: () => 200_000,
      async *stream(req) {
        capturedReq = { signal: req.signal, messages: req.messages };
        yield { type: "message_start", model: "test-model" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider: capturingProvider,
      model: "test-model",
      sessionStore: store,
    });
    const session = await agent.session();
    const { getSessionInternals } = await import("./session.js");
    const si = getSessionInternals(session);

    await collectEvents(session.run("hello"));

    expect(capturedReq).toBeDefined();
    expect(capturedReq!.signal).toBeInstanceOf(AbortSignal);
    // messages at time of request = [userMsg] which is in providerView
    expect(capturedReq!.messages).toBe(si.providerView);

    await agent.close();
  });

  it("propagates cacheTtl from Agent to ProviderRequest.cache_ttl", async () => {
    let capturedTtl: "5m" | "1h" | undefined;

    const provider: import("../providers/base.js").BaseProvider = {
      id: "ttl-capture",
      contextWindow: () => 200_000,
      async *stream(req) {
        capturedTtl = req.cache_ttl;
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "m",
      sessionStore: store,
      cacheTtl: "1h",
    });
    const session = await agent.session();
    await collectEvents(session.run("hi"));

    expect(capturedTtl).toBe("1h");

    await agent.close();
  });

  it("omits cache_ttl when Agent.cacheTtl is not set", async () => {
    let captured: { cache_ttl?: "5m" | "1h"; has: boolean } | undefined;

    const provider: import("../providers/base.js").BaseProvider = {
      id: "ttl-absent",
      contextWindow: () => 200_000,
      async *stream(req) {
        captured = { cache_ttl: req.cache_ttl, has: "cache_ttl" in req };
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "m", sessionStore: store });
    const session = await agent.session();
    await collectEvents(session.run("hi"));

    expect(captured?.cache_ttl).toBeUndefined();
    expect(captured?.has).toBe(false);

    await agent.close();
  });

  it("propagates RunOptions.thinking and effort to ProviderRequest", async () => {
    let captured: { thinking?: unknown; effort?: unknown } | undefined;

    const provider: import("../providers/base.js").BaseProvider = {
      id: "thinking-capture",
      contextWindow: () => 200_000,
      async *stream(req) {
        captured = { thinking: req.thinking, effort: req.effort };
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "m", sessionStore: store });
    const session = await agent.session();
    await collectEvents(
      session.run("hi", {
        thinking: { type: "enabled", budget_tokens: 4000 },
        effort: "max",
      }),
    );

    expect(captured?.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(captured?.effort).toBe("max");

    await agent.close();
  });

  it("omits thinking and effort when RunOptions does not set them", async () => {
    let captured: { hasThinking: boolean; hasEffort: boolean } | undefined;

    const provider: import("../providers/base.js").BaseProvider = {
      id: "thinking-absent",
      contextWindow: () => 200_000,
      async *stream(req) {
        captured = { hasThinking: "thinking" in req, hasEffort: "effort" in req };
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "m", sessionStore: store });
    const session = await agent.session();
    await collectEvents(session.run("hi"));

    expect(captured?.hasThinking).toBe(false);
    expect(captured?.hasEffort).toBe(false);

    await agent.close();
  });

  it("propagates AgentOptions.maxRetries to ProviderRequest.max_retries", async () => {
    let capturedMaxRetries: number | undefined;

    const provider: import("../providers/base.js").BaseProvider = {
      id: "retries-capture",
      contextWindow: () => 200_000,
      async *stream(req) {
        capturedMaxRetries = req.max_retries;
        yield { type: "message_start", model: "m" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "m", sessionStore: store, maxRetries: 3 });
    const session = await agent.session();
    await collectEvents(session.run("hi"));

    expect(capturedMaxRetries).toBe(3);

    await agent.close();
  });
});

describe("runLoop — first user message has env block", () => {
  it("first content block of user message is the <env> text block", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript());
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const events = await collectEvents(session.run("do something"));

    const userEvent = events.find(e => e.type === "user") as Extract<Event, { type: "user" }> | undefined;
    expect(userEvent).toBeDefined();
    const firstBlock = userEvent!.message.content[0];
    expect(firstBlock.type).toBe("text");
    // The env block starts with <env>
    expect((firstBlock as { text: string }).text).toContain("<env>");

    await agent.close();
  });
});

describe("runLoop — SessionStore receives appends", () => {
  it("user message and assistant message land in the store", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("world"));
    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
    });
    const session = await agent.session();

    await collectEvents(session.run("hello"));

    const stored = await store.loadMessages(session.id);
    expect(stored.length).toBe(2); // user + assistant

    expect(stored[0].message.role).toBe("user");
    expect(stored[1].message.role).toBe("assistant");

    const asstText = stored[1].message.content.find(b => b.type === "text");
    expect((asstText as { text: string } | undefined)?.text).toBe("world");

    await agent.close();
  });
});

describe("runLoop — tool_use stream assembly", () => {
  it("assembles ToolUseBlock from start/delta/end events with partial emission", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "tool_use_start", id: "tu-1", name: "Read" },
        { type: "tool_use_input_delta", id: "tu-1", json_delta: '{"path"' },
        { type: "tool_use_input_delta", id: "tu-1", json_delta: ':"foo.ts"}' },
        { type: "tool_use_end", id: "tu-1" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 8 },
        },
      ],
    });

    // We need a way to stop after the assistant event without running tool calls
    // (scheduler is not implemented). Collect events up to the error.
    const provider2 = new MockProvider();
    provider2.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "tool_use_start", id: "tu-1", name: "Read" },
        { type: "tool_use_input_delta", id: "tu-1", json_delta: '{"path":"foo.ts"}' },
        { type: "tool_use_end", id: "tu-1" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 8 },
        },
      ],
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider: provider2,
      model: "test-model",
      sessionStore: store,
    });
    const session = await agent.session();

    // Collect until we see the assistant event (then stop consuming to avoid scheduler throw)
    const collected: Event[] = [];
    for await (const ev of session.run("use a tool")) {
      collected.push(ev);
      if (ev.type === "assistant") break;
    }

    const asstEvent = collected.find(e => e.type === "assistant") as
      | Extract<Event, { type: "assistant" }>
      | undefined;
    expect(asstEvent).toBeDefined();

    const toolBlock = asstEvent!.message.content.find(b => b.type === "tool_use") as
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      | undefined;
    expect(toolBlock).toBeDefined();
    expect(toolBlock!.id).toBe("tu-1");
    expect(toolBlock!.name).toBe("Read");
    expect(toolBlock!.input).toEqual({ path: "foo.ts" });

    await agent.close();
  });

  it("marks invalid JSON tool input with __invalidJson flag", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "tool_use_start", id: "tu-bad", name: "Write" },
        { type: "tool_use_input_delta", id: "tu-bad", json_delta: "NOT JSON {{{" },
        { type: "tool_use_end", id: "tu-bad" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      ],
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
    });
    const session = await agent.session();

    const collected: Event[] = [];
    for await (const ev of session.run("bad tool")) {
      collected.push(ev);
      if (ev.type === "assistant") break;
    }

    const asstEvent = collected.find(e => e.type === "assistant") as
      | Extract<Event, { type: "assistant" }>
      | undefined;
    expect(asstEvent).toBeDefined();

    const toolBlock = asstEvent!.message.content.find(b => b.type === "tool_use") as
      | { type: "tool_use"; input: Record<string, unknown> }
      | undefined;
    expect(toolBlock).toBeDefined();
    expect(toolBlock!.input.__invalidJson).toBe(true);
    expect(typeof toolBlock!.input.raw).toBe("string");

    await agent.close();
  });
});

describe("runLoop — turn limit", () => {
  it("maxTurns exhausted emits TurnLimitError after N turns of tool_use", async () => {
    const provider = new MockProvider();

    // MockWrite tool so scheduler can actually run tool calls
    const write = new MockWriteTool("write-ok");
    Object.defineProperty(write, "name", { value: "MockWrite", writable: false });
    const tools = new ToolRegistry();
    tools.register(write);

    // Turn 1: tool_use → write result → Turn 2: tool_use → write result → Turn limit hit
    // maxTurns: 2 means only 2 turns before the error
    for (let i = 0; i < 3; i++) {
      provider.enqueue({
        events: [
          { type: "message_start", model: "test-model" },
          { type: "tool_use_start", id: `tu-limit-${i}`, name: "MockWrite" },
          { type: "tool_use_input_delta", id: `tu-limit-${i}`, json_delta: "{}" },
          { type: "tool_use_end", id: `tu-limit-${i}` },
          {
            type: "message_end",
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        ],
      });
    }

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      tools,
      maxTurns: 2,
      permissions: { mode: "yolo" },
    });
    const session = await agent.session();

    const events = await collectEvents(session.run("keep going"));

    const errorEvent = events.find(e => e.type === "error") as Extract<Event, { type: "error" }> | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error.name).toBe("TurnLimitError");
    expect(errorEvent!.error.message).toContain("max turns");

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("error");

    await agent.close();
  });

  it("default maxTurns is unbounded: many tool_use turns complete without TurnLimitError", async () => {
    const provider = new MockProvider();

    const write = new MockWriteTool("write-ok");
    Object.defineProperty(write, "name", { value: "MockWrite", writable: false });
    const tools = new ToolRegistry();
    tools.register(write);

    // 5 tool_use turns, then a final end_turn. With the old default of 100 this
    // would pass too, but the point is to prove no cap is applied by default.
    for (let i = 0; i < 5; i++) {
      provider.enqueue({
        events: [
          { type: "message_start", model: "test-model" },
          { type: "tool_use_start", id: `tu-unbounded-${i}`, name: "MockWrite" },
          { type: "tool_use_input_delta", id: `tu-unbounded-${i}`, json_delta: "{}" },
          { type: "tool_use_end", id: `tu-unbounded-${i}` },
          { type: "message_end", stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 3 } },
        ],
      });
    }
    provider.enqueue(simpleTextScript("done"));

    const store = new InMemorySessionStore();
    // No maxTurns supplied → defaults to Infinity (unbounded).
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      tools,
      permissions: { mode: "yolo" },
    });
    expect(getAgentInternals(agent).maxTurns).toBe(Infinity);

    const session = await agent.session();
    const events = await collectEvents(session.run("keep going"));

    expect(events.find(e => e.type === "error")).toBeUndefined();
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("success");

    await agent.close();
  });
});

describe("runLoop — full tool round-trip", () => {
  it("turn 1 tool_use → tool executes → turn 2 end_turn; correct event sequence", async () => {
    const provider = new MockProvider();
    const read = new MockReadTool("file content");
    Object.defineProperty(read, "name", { value: "MockRead", writable: false });

    const tools = new ToolRegistry();
    tools.register(read);

    // Turn 1: returns tool_use for MockRead
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "tool_use_start", id: "tu-rt-1", name: "MockRead" },
        { type: "tool_use_input_delta", id: "tu-rt-1", json_delta: "{}" },
        { type: "tool_use_end", id: "tu-rt-1" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
    });

    // Turn 2: end_turn after seeing tool result
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "done" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 3 },
        },
      ],
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      tools,
      permissions: { mode: "yolo" },
    });
    const session = await agent.session();

    // Resolve the read immediately
    const eventsPromise = collectEvents(session.run("read something"));
    await new Promise(r => setTimeout(r, 10));
    read.deferred.resolve();

    const events = await eventsPromise;

    const types = events.map(e => e.type);

    // Expected sequence: system, user, assistant(tool_use), usage, tool_call_start,
    //   tool_call_end, user(tool_result), assistant(end_turn), usage, result
    expect(types).toContain("system");
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types).toContain("usage");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_call_end");
    expect(types).toContain("result");

    // Verify order
    const systemIdx = types.indexOf("system");
    const firstUserIdx = types.indexOf("user");
    const firstAsstIdx = types.indexOf("assistant");
    const firstUsageIdx = types.indexOf("usage");
    const toolStartIdx = types.indexOf("tool_call_start");
    const toolEndIdx = types.indexOf("tool_call_end");
    // second user event (tool_result)
    const secondUserIdx = types.lastIndexOf("user");
    const secondAsstIdx = types.lastIndexOf("assistant");
    const resultIdx = types.lastIndexOf("result");

    expect(systemIdx).toBeLessThan(firstUserIdx);
    expect(firstUserIdx).toBeLessThan(firstAsstIdx);
    expect(firstAsstIdx).toBeLessThan(firstUsageIdx);
    expect(firstUsageIdx).toBeLessThan(toolStartIdx);
    expect(toolStartIdx).toBeLessThan(toolEndIdx);
    expect(toolEndIdx).toBeLessThan(secondUserIdx);
    expect(secondUserIdx).toBeLessThan(secondAsstIdx);
    expect(secondAsstIdx).toBeLessThan(resultIdx);

    // The tool result user message should contain a tool_result block
    const userEvents = events.filter(e => e.type === "user") as Extract<Event, { type: "user" }>[];
    expect(userEvents.length).toBeGreaterThanOrEqual(2);
    const toolResultUser = userEvents[userEvents.length - 1]!;
    const toolResultBlock = toolResultUser.message.content.find(b => b.type === "tool_result");
    expect(toolResultBlock).toBeDefined();
    expect((toolResultBlock as { tool_use_id: string }).tool_use_id).toBe("tu-rt-1");

    // Result should be success
    const resultEvent = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(resultEvent.subtype).toBe("success");
    expect(resultEvent.final_text).toBe("done");

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// runLoop — compaction integration tests (Phase 5)
// ---------------------------------------------------------------------------

describe("runLoop — compaction trigger via threshold", () => {
  it("emits CompactionEvent before AssistantEvent when usage crosses 80% threshold on subsequent run", async () => {
    // MockProvider contextWindow = 200_000; threshold = 160_000
    // Turn 1 reports input_tokens = 155_000, maxOutputTokens = 8192 → projected = 163_192 > 160_000
    // Override strategy that never calls provider stream (avoids needing extra enqueue)
    const noopStrategy: CompactionStrategy = {
      id: "noop-loop-test",
      async compact({ messages }) { return messages.slice(-1).length > 0 ? messages.slice(-1) : messages; },
    };

    const provider = new MockProvider();

    // Run 1: end_turn with high usage
    provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "text_delta" as const, text: "run1" },
        {
          type: "message_end" as const,
          stop_reason: "end_turn" as const,
          usage: { input_tokens: 155_000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    // Run 2: end_turn (after compaction)
    provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "text_delta" as const, text: "run2" },
        {
          type: "message_end" as const,
          stop_reason: "end_turn" as const,
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      maxOutputTokens: 8192,
      compaction: noopStrategy,
    });
    const session = await agent.session();

    // First run: high usage
    const events1 = await collectEvents(session.run("hello"));
    const result1 = events1.find(e => e.type === "result") as ResultEvent | undefined;
    expect(result1?.subtype).toBe("success");

    // Second run: threshold trips, CompactionEvent emitted before AssistantEvent
    const events2 = await collectEvents(session.run("go again"));
    const types2 = events2.map(e => e.type);

    expect(types2).toContain("compaction");

    const compIdx = types2.indexOf("compaction");
    const asstIdx = types2.indexOf("assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    const ce = events2[compIdx] as CompactionEvent;
    expect(ce.strategy).toBe("noop-loop-test");

    await agent.close();
  });
});

describe("runLoop — ContextLengthError recovery", () => {
  it("emits CompactionEvent between error and retry assistant message", async () => {
    // The strategy must actually change the view — an unchanged view is a
    // no-op and the ContextLengthError is rethrown instead of retried.
    const noopStrategy: CompactionStrategy = {
      id: "noop-recovery-test",
      async compact() {
        return [{ role: "user" as const, content: [{ type: "text" as const, text: "condensed" }] }];
      },
    };

    const provider = new MockProvider();

    // Turn 1: throws ContextLengthError (no events emitted before throw)
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long"),
    });

    // Retry after compaction: succeeds
    provider.enqueue({
      events: [
        { type: "message_start" as const, model: "test-model" as const },
        { type: "text_delta" as const, text: "recovered" },
        {
          type: "message_end" as const,
          stop_reason: "end_turn" as const,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      compaction: noopStrategy,
    });
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));
    const types = events.map(e => e.type);

    // Must contain compaction
    expect(types).toContain("compaction");

    // Compaction before assistant
    const compIdx = types.indexOf("compaction");
    const asstIdx = types.indexOf("assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    // Result is success
    const resultEvent = events.find(e => e.type === "result") as ResultEvent | undefined;
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.subtype).toBe("success");

    // Assistant has the recovered text
    const asstEvent = events.find(e => e.type === "assistant") as AssistantEvent | undefined;
    const textBlock = asstEvent!.message.content.find(b => b.type === "text");
    expect((textBlock as { text: string } | undefined)?.text).toBe("recovered");

    await agent.close();
  });
});

describe("runLoop — second ContextLengthError in same turn surfaces as error", () => {
  it("second ContextLengthError (after compaction retry used) escapes as ErrorEvent + ResultEvent(error)", async () => {
    const noopStrategy: CompactionStrategy = {
      id: "noop-double-ctx-test",
      async compact({ messages }) { return messages; },
    };

    const provider = new MockProvider();

    // First call: ContextLengthError — triggers compaction + retry
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long (first)"),
    });

    // Retry after compaction: ALSO ContextLengthError — must NOT be swallowed
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long (second)"),
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      compaction: noopStrategy,
    });
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));

    const errorEvent = events.find(e => e.type === "error") as Extract<Event, { type: "error" }> | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error.name).toBe("ContextLengthError");

    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("error");

    await agent.close();
  });
});
