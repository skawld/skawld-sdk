/** Tests for compaction module (Phase 5). */

import { describe, expect, it } from "bun:test";
import { Agent } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import { getSessionInternals } from "./session.js";
import { getAgentInternals } from "./agent.js";
import {
  lastNTurnBoundaries,
  defaultCompaction,
  maybeCompact,
  runForcedCompaction,
  stripResponseChaining,
} from "./compaction.js";
import type { Message } from "./types.js";
import type { CompactionStrategy, CompactionContext } from "./compaction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(role: "user" | "assistant", text = "x"): Message {
  return { role, content: [{ type: "text", text }] };
}

/** Build a message sequence with N assistant turns (each preceded by a user msg). */
function buildHistory(assistantCount: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < assistantCount; i++) {
    msgs.push(makeMsg("user", `user ${i}`));
    msgs.push(makeMsg("assistant", `asst ${i}`));
  }
  return msgs;
}

function makeAgent(provider: MockProvider, opts?: { maxOutputTokens?: number; compaction?: CompactionStrategy }) {
  const store = new InMemorySessionStore();
  const agent = new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    maxOutputTokens: opts?.maxOutputTokens ?? 8192,
    compaction: opts?.compaction,
  });
  return { agent, store };
}

function endTurnScript(text = "ok", inputTokens = 10) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// lastNTurnBoundaries
// ---------------------------------------------------------------------------

describe("lastNTurnBoundaries", () => {
  it("returns all messages when fewer than n assistant messages exist", () => {
    const msgs = buildHistory(5); // 5 assistant messages
    const result = lastNTurnBoundaries(msgs, 10);
    expect(result).toBe(msgs); // same reference — no copy
    expect(result.length).toBe(10);
  });

  it("returns slice from first assistant when exactly n assistant messages exist", () => {
    // buildHistory(10) = [u0,a0, u1,a1, ..., u9,a9] — 10 assistant messages
    // Walking backwards: a9(idx19)=1, a8(idx17)=2, ..., a0(idx1)=10
    // boundaryIndex = 1 (a0), slice(1) = 19 messages (a0 through a9 with interleaved users)
    const msgs = buildHistory(10);
    const result = lastNTurnBoundaries(msgs, 10);
    expect(result.length).toBe(19);
    expect(result[0]!.role).toBe("assistant");
    expect((result[0]!.content[0] as { text: string }).text).toBe("asst 0");
  });

  it("returns slice starting from the n-th-from-last assistant when more than n exist", () => {
    const msgs = buildHistory(15); // 15 assistant msgs, 30 total
    const result = lastNTurnBoundaries(msgs, 10);
    // Should keep last 10 assistant messages, i.e. start from pair #5 (0-indexed)
    // pair 5 = msgs[10] (user) and msgs[11] (assistant)
    // The 10th assistant from the end is at index 10 in a 30-msg array? Let me think:
    // msgs: [u0,a0, u1,a1, ..., u14,a14]
    // Walking backwards: a14 (idx 29) = 1, a13 (idx 27) = 2, ..., a5 (idx 11) = 10
    // So boundaryIndex = 11 (the 10th assistant from the end is a5 at index 11? No)
    // pairs: [u0,a0](0,1), [u1,a1](2,3), ..., [u14,a14](28,29)
    // Walk backwards on assistants: a14=idx29 (1), a13=idx27 (2), ..., a5=idx11 (10)
    // boundaryIndex = 11 → slice from 11 to end = 30-11 = 19 messages
    expect(result.length).toBe(19);
    // First message should be assistant a5
    expect(result[0]!.role).toBe("assistant");
    expect((result[0]!.content[0] as { text: string }).text).toBe("asst 5");
  });

  it("keeps trailing non-assistant messages with their assistant boundary", () => {
    const msgs = buildHistory(12);
    // Add a trailing user message (e.g. tool result after last assistant)
    msgs.push(makeMsg("user", "tool result"));
    // msgs length = 25; assistants at even positions 1,3,5,...,23
    const result = lastNTurnBoundaries(msgs, 10);
    // The 10th-from-last assistant is a2 (index 5 in pairs = index 5 in 0-based asst count)
    // pairs [u0,a0](0,1),[u1,a1](2,3),...,[u11,a11](22,23),[user-tool](24)
    // Assistants: indices 1,3,5,7,9,11,13,15,17,19,21,23 — 12 total
    // 10th from end = a2 at index 5 (pair 2: u2=idx4, a2=idx5)
    // → boundaryIndex = 5, slice from 5 to 25 = 20 messages
    expect(result.length).toBe(20);
    // Last message should be the trailing user message
    expect(result[result.length - 1]!.role).toBe("user");
    expect((result[result.length - 1]!.content[0] as { text: string }).text).toBe("tool result");
  });

  it("returns empty array unchanged", () => {
    const result = lastNTurnBoundaries([], 10);
    expect(result.length).toBe(0);
  });

  it("handles messages with no assistant at all", () => {
    const msgs = [makeMsg("user", "a"), makeMsg("user", "b")];
    const result = lastNTurnBoundaries(msgs, 1);
    expect(result).toBe(msgs);
  });
});

// ---------------------------------------------------------------------------
// defaultCompaction.compact
// ---------------------------------------------------------------------------

describe("defaultCompaction.compact", () => {
  it("returns messages unchanged when older slice is empty (≤10 assistant turns)", async () => {
    const provider = new MockProvider();
    const msgs = buildHistory(8); // 8 assistant messages → all kept as "recent"
    const result = await defaultCompaction.compact({
      messages: msgs,
      provider,
      model: "test-model",
      signal: new AbortController().signal,
    });
    expect(result).toBe(msgs);
  });

  it("returns messages unchanged when fewer than 10 assistant turns (7)", async () => {
    const provider = new MockProvider();
    const msgs = buildHistory(7); // 7 < 10 → older is empty → no-op
    const result = await defaultCompaction.compact({
      messages: msgs,
      provider,
      model: "test-model",
      signal: new AbortController().signal,
    });
    expect(result).toBe(msgs);
  });

  it("summarizes older messages into a synthetic user message when >10 turns", async () => {
    const provider = new MockProvider();
    // Script the summary provider response
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "Summary " },
        { type: "text_delta", text: "content here." },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      ],
    });

    const msgs = buildHistory(15); // 15 assistant turns, 30 messages total
    const result = await defaultCompaction.compact({
      messages: msgs,
      provider,
      model: "test-model",
      signal: new AbortController().signal,
    });

    // Should start with synthetic summary user message
    expect(result[0]!.role).toBe("user");
    const firstBlock = result[0]!.content[0] as { type: string; text: string };
    expect(firstBlock.type).toBe("text");
    expect(firstBlock.text).toContain("<summary of earlier conversation>");
    expect(firstBlock.text).toContain("Summary content here.");

    // Tail should be the recent slice (last 10 turns = 19 messages starting from asst 5)
    const recent = lastNTurnBoundaries(msgs, 10);
    expect(result.length).toBe(1 + recent.length);
    // The last message in result should be the last message in msgs
    expect(result[result.length - 1]).toBe(msgs[msgs.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// stripResponseChaining
// ---------------------------------------------------------------------------

describe("stripResponseChaining", () => {
  function chainedMsg(text: string, responseId: string): Message {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      provider_metadata: { openai_responses: { response_id: responseId } },
    };
  }

  it("removes response_id from every message without mutating the originals", () => {
    const original = chainedMsg("a", "resp_1");
    const plain = makeMsg("user", "b");
    const result = stripResponseChaining([original, plain]);

    expect(result[0]!.provider_metadata?.openai_responses?.response_id).toBeUndefined();
    // Originals untouched — they are shared with fullHistory and the store
    expect(original.provider_metadata!.openai_responses!.response_id).toBe("resp_1");
    // Messages without a response_id pass through by reference
    expect(result[1]).toBe(plain);
  });

  it("preserves other provider metadata while stripping the id", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "a" }],
      provider_metadata: {
        openai_responses: { response_id: "resp_1", output_items: [{ type: "message" }] },
      },
    };
    const [result] = stripResponseChaining([msg]);
    expect(result!.provider_metadata?.openai_responses?.response_id).toBeUndefined();
    expect(result!.provider_metadata?.openai_responses?.output_items).toEqual([{ type: "message" }]);
  });

  it("drops provider_metadata entirely when nothing else remains", () => {
    const [result] = stripResponseChaining([chainedMsg("a", "resp_1")]);
    expect(result!.provider_metadata).toBeUndefined();
  });

  it("defaultCompaction returns a view with no response_id on any message", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "summary" },
        { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    });

    const msgs = buildHistory(15);
    // Mark every assistant message as a chained Responses turn
    for (const m of msgs) {
      if (m.role === "assistant") {
        m.provider_metadata = { openai_responses: { response_id: `resp_${msgs.indexOf(m)}` } };
      }
    }

    const result = await defaultCompaction.compact({
      messages: msgs,
      provider,
      model: "test-model",
      signal: new AbortController().signal,
    });

    for (const m of result) {
      expect(m.provider_metadata?.openai_responses?.response_id).toBeUndefined();
    }
  });

  it("post-compaction Responses payload replays statelessly, then chaining resumes", async () => {
    const { buildPayload } = await import("../providers/openai-responses.js");
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "the summary" },
        { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    });

    const msgs = buildHistory(15);
    for (const m of msgs) {
      if (m.role === "assistant") {
        m.provider_metadata = { openai_responses: { response_id: `resp_${msgs.indexOf(m)}` } };
      }
    }

    const compacted = await defaultCompaction.compact({
      messages: msgs,
      provider,
      model: "test-model",
      signal: new AbortController().signal,
    });

    // The next request sends the whole compacted view (summary first) with no chaining
    const payload = buildPayload({
      model: "gpt-test",
      system: [],
      tools: [],
      messages: compacted,
      signal: new AbortController().signal,
    });
    expect(payload.previous_response_id).toBeUndefined();
    const first = payload.input[0] as { type: string; role?: string; content?: Array<{ text?: string }> };
    expect(first.role).toBe("user");
    expect(first.content?.[0]?.text).toContain("the summary");
    // All kept turns are present as input items (summary + 19 kept messages)
    expect(payload.input.length).toBeGreaterThanOrEqual(compacted.length);

    // A new chained assistant response after the stateless replay resumes chaining
    const afterReplay: Message[] = [
      ...compacted,
      {
        role: "assistant",
        content: [{ type: "text", text: "fresh" }],
        provider_metadata: { openai_responses: { response_id: "resp_new" } },
      },
      makeMsg("user", "next prompt"),
    ];
    const chainedPayload = buildPayload({
      model: "gpt-test",
      system: [],
      tools: [],
      messages: afterReplay,
      signal: new AbortController().signal,
    });
    expect(chainedPayload.previous_response_id).toBe("resp_new");
  });
});

// ---------------------------------------------------------------------------
// maybeCompact
// ---------------------------------------------------------------------------

describe("maybeCompact", () => {
  it("returns false when lastUsage is undefined (first turn)", async () => {
    const provider = new MockProvider();
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);
    // lastUsage starts undefined
    expect(si.lastUsage).toBeUndefined();

    const result = await maybeCompact(si, ai, new AbortController().signal);
    expect(result).toBe(false);

    await agent.close();
  });

  it("returns false when projected tokens < 80% of context window", async () => {
    const provider = new MockProvider();
    // contextWindow = 200_000 (default MockProvider), maxOutputTokens = 8192
    // 0.8 * 200_000 = 160_000
    // input_tokens needs to be < 160_000 - 8192 = 151_808
    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    // Set usage below threshold
    si.lastUsage = { input_tokens: 100_000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 };

    const result = await maybeCompact(si, ai, new AbortController().signal);
    expect(result).toBe(false);

    await agent.close();
  });

  it("returns true and compacts when threshold is crossed", async () => {
    const provider = new MockProvider();
    // contextWindow = 200_000, threshold at 0.8 = 160_000
    // We'll set input_tokens = 155_000, maxOutputTokens = 8192 → projected = 163_192 > 160_000
    // defaultCompaction will try to call provider.stream for summarization;
    // we need to script a summary response first (>10 assistant turns needed in providerView)
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "summary" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      ],
    });

    const { agent } = makeAgent(provider, { maxOutputTokens: 8192 });
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    // Set up providerView with >10 assistant turns
    const history = buildHistory(15);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);
    // Also set fullHistory length for comparison
    si.fullHistory.length = 0;
    for (const m of history) si.fullHistory.push(m);

    si.lastUsage = { input_tokens: 155_000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 };

    const fullHistoryLengthBefore = si.fullHistory.length;

    const result = await maybeCompact(si, ai, new AbortController().signal);
    expect(result).toBe(true);

    // providerView should have shrunk
    expect(si.providerView.length).toBeLessThan(history.length);

    // fullHistory unchanged
    expect(si.fullHistory.length).toBe(fullHistoryLengthBefore);

    // lastCompactionInfo populated
    expect(si.lastCompactionInfo).toBeDefined();
    expect(si.lastCompactionInfo!.type).toBe("compaction");
    expect(si.lastCompactionInfo!.messages_before).toBe(history.length);
    expect(si.lastCompactionInfo!.strategy).toBe("default-keep-recent-10");
    expect(si.lastCompactionInfo!.tokens_before).toBe(155_000);
    expect(si.lastCompactionInfo!.tokens_after).toBe(0); // unknown until next response
    // The summarization call's usage is surfaced for cost accounting.
    expect(si.lastCompactionInfo!.summary_usage).toEqual({ input_tokens: 100, output_tokens: 5 });

    await agent.close();
  });

  it("triggers on cache-heavy usage where input_tokens is the cache-inclusive total", async () => {
    // Steady-state cached session: almost all of the prompt is cache reads.
    // Providers normalize input_tokens to the cache-inclusive total, so the
    // 80% trigger must fire on input_tokens alone.
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "summary" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      ],
    });

    const { agent } = makeAgent(provider, { maxOutputTokens: 8192 });
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    const history = buildHistory(15);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);

    // 161_000 total prompt, 159_000 of it cached reads. 161_000 + 8192 > 160_000.
    si.lastUsage = { input_tokens: 161_000, output_tokens: 500, cache_read_tokens: 159_000, cache_creation_tokens: 0 };

    const result = await maybeCompact(si, ai, new AbortController().signal);
    expect(result).toBe(true);
    expect(si.providerView.length).toBeLessThan(history.length);

    await agent.close();
  });

  it("returns false and emits no event when above threshold but defaultCompaction is a no-op (≤10 turns)", async () => {
    // defaultCompaction is a no-op when there are ≤10 assistant turns (nothing to compact).
    // Even though usage is above 80%, maybeCompact must return false so the loop emits no CompactionEvent.
    const provider = new MockProvider();
    // maxOutputTokens = 8192; contextWindow = 200_000; threshold = 160_000
    // projected = 155_000 + 8192 = 163_192 > 160_000 → above threshold
    const { agent } = makeAgent(provider, { maxOutputTokens: 8192 });
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    // Only 5 assistant turns — defaultCompaction returns messages unchanged
    const history = buildHistory(5);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);

    si.lastUsage = { input_tokens: 155_000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 };

    const result = await maybeCompact(si, ai, new AbortController().signal);
    expect(result).toBe(false);
    // No compaction info should be stashed
    expect(si.lastCompactionInfo).toBeUndefined();
    // providerView unchanged
    expect(si.providerView.length).toBe(history.length);

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// runForcedCompaction
// ---------------------------------------------------------------------------

describe("runForcedCompaction", () => {
  it("runs compaction unconditionally even when threshold is not crossed", async () => {
    const provider = new MockProvider();
    // Script the summary response (needs >10 assistant turns)
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "forced summary" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    });

    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    // Well below threshold
    si.lastUsage = { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 };

    const history = buildHistory(15);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);
    si.fullHistory.length = 0;
    for (const m of history) si.fullHistory.push(m);

    const fullHistoryLengthBefore = si.fullHistory.length;

    await runForcedCompaction(si, ai, new AbortController().signal);

    // providerView shrank
    expect(si.providerView.length).toBeLessThan(history.length);
    // fullHistory unchanged
    expect(si.fullHistory.length).toBe(fullHistoryLengthBefore);
    // lastCompactionInfo set
    expect(si.lastCompactionInfo).toBeDefined();
    expect(si.lastCompactionInfo!.messages_before).toBe(history.length);

    await agent.close();
  });

  it("runs with no prior usage (lastUsage undefined)", async () => {
    const provider = new MockProvider();
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "summary" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    });

    const { agent } = makeAgent(provider);
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    // lastUsage undefined — forced should still run
    expect(si.lastUsage).toBeUndefined();

    const history = buildHistory(15);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);

    await runForcedCompaction(si, ai, new AbortController().signal);

    expect(si.providerView.length).toBeLessThan(history.length);
    expect(si.lastCompactionInfo!.tokens_before).toBe(0); // 0 when no prior usage

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Override strategy
// ---------------------------------------------------------------------------

describe("compaction strategy override", () => {
  it("uses override strategy instead of defaultCompaction", async () => {
    const provider = new MockProvider();
    const singleMsg = makeMsg("user", "the only message");
    const overrideStrategy: CompactionStrategy = {
      id: "test-override",
      async compact(_ctx: CompactionContext): Promise<Message[]> {
        return [singleMsg];
      },
    };

    const { agent } = makeAgent(provider, { compaction: overrideStrategy });
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);

    si.lastUsage = { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 };
    const history = buildHistory(5);
    si.providerView.length = 0;
    for (const m of history) si.providerView.push(m);

    await runForcedCompaction(si, ai, new AbortController().signal);

    expect(si.providerView.length).toBe(1);
    expect(si.providerView[0]).toBe(singleMsg);
    expect(si.lastCompactionInfo!.strategy).toBe("test-override");
    expect(si.lastCompactionInfo!.messages_before).toBe(history.length);
    expect(si.lastCompactionInfo!.messages_after).toBe(1);

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: maybeCompact triggered via runLoop
// ---------------------------------------------------------------------------

describe("runLoop — compaction trigger via high token usage", () => {
  it("emits CompactionEvent before turn 2 when usage crosses threshold after turn 1", async () => {
    // contextWindow = 200_000 (MockProvider default), threshold = 160_000
    // maxOutputTokens = 8192 → need input_tokens >= 160_000 - 8192 = 151_808
    // We'll report input_tokens = 155_000 on turn 1.
    // For compaction to run, providerView needs >10 assistant messages.
    // But we only have the turn 1 assistant message in providerView when maybeCompact runs on turn 2.
    // So defaultCompaction won't actually compact (≤10 turns → returns unchanged).
    // We need an override strategy that runs unconditionally.

    const provider = new MockProvider();

    // Turn 1: end_turn with high usage
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "turn1" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 155_000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    // Turn 2 (after compaction): end_turn
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "turn2" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    // Use an override strategy that always compacts (no provider call needed)
    const noop: CompactionStrategy = {
      id: "noop-test",
      async compact({ messages }) { return messages.slice(-1); }, // just keep last msg
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      maxOutputTokens: 8192,
      compaction: noop,
      // Simulate a second prompt by using maxTurns = 1 to stop after turn 1
      // Actually we need 2 turns: turn 1 emits high usage, turn 2 sees compaction
      // We use a different approach: session.run fires turn 1, then session.run again
    });

    const session = await agent.session();

    // First run: high usage response
    const events1: import("./events.js").Event[] = [];
    for await (const ev of session.run("hello")) {
      events1.push(ev);
    }
    expect(events1.find(e => e.type === "result" && (e as import("./events.js").ResultEvent).subtype === "success")).toBeDefined();

    // Second run: threshold should trip at top of turn 1 in the second run
    const events2: import("./events.js").Event[] = [];
    for await (const ev of session.run("go again")) {
      events2.push(ev);
    }

    const compactionEvents = events2.filter(e => e.type === "compaction");
    expect(compactionEvents.length).toBe(1);

    const ce = compactionEvents[0] as import("./events.js").CompactionEvent;
    expect(ce.strategy).toBe("noop-test");

    // Compaction should appear before the assistant event in run 2
    const compIdx = events2.findIndex(e => e.type === "compaction");
    const asstIdx = events2.findIndex(e => e.type === "assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: ContextLengthError recovery emits CompactionEvent
// ---------------------------------------------------------------------------

describe("runLoop — ContextLengthError recovery emits CompactionEvent", () => {
  it("emits CompactionEvent after ContextLengthError before retry assistant message", async () => {
    const { ContextLengthError } = await import("./errors.js");
    const provider = new MockProvider();

    // Turn 1: throws ContextLengthError immediately
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long"),
    });

    // Turn 1 retry (after compaction): end_turn success
    provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "recovered" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    // Use an override strategy that always compacts without calling provider.
    // It must actually change the view — an unchanged view is treated as a
    // no-op and the ContextLengthError is rethrown instead of retried.
    const noop: CompactionStrategy = {
      id: "noop-recovery",
      async compact() {
        return [makeMsg("user", "condensed")];
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      compaction: noop,
    });
    const session = await agent.session();

    const events: import("./events.js").Event[] = [];
    for await (const ev of session.run("hi")) {
      events.push(ev);
    }

    const types = events.map(e => e.type);

    // Should contain a compaction event
    expect(types).toContain("compaction");

    // CompactionEvent should precede AssistantEvent
    const compIdx = types.indexOf("compaction");
    const asstIdx = types.indexOf("assistant");
    expect(compIdx).toBeGreaterThanOrEqual(0);
    expect(compIdx).toBeLessThan(asstIdx);

    // Result should be success (recovered)
    const resultEvent = events.find(e => e.type === "result") as import("./events.js").ResultEvent | undefined;
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.subtype).toBe("success");

    // The assistant message should have the recovered text
    const asstEvent = events.find(e => e.type === "assistant") as import("./events.js").AssistantEvent | undefined;
    expect(asstEvent).toBeDefined();
    const textBlock = asstEvent!.message.content.find(b => b.type === "text");
    expect((textBlock as { text: string } | undefined)?.text).toBe("recovered");

    await agent.close();
  });

  it("re-injects skill listing and invoked skill bodies into the retry request", async () => {
    const { ContextLengthError } = await import("./errors.js");
    const provider = new MockProvider();

    // Turn 1: context overflow
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long"),
    });

    // Retry: only matches when the re-injected skill context is in the request.
    // Without re-injection the run falls back to an empty cursor queue and errors.
    provider.enqueueFor(
      (req) =>
        req.messages.some(m =>
          m.content.some(b => b.type === "text" && b.text.includes("skill_listing")),
        ) &&
        req.messages.some(m =>
          m.content.some(b => b.type === "text" && b.text.includes("FOO SKILL BODY")),
        ),
      {
        events: [
          { type: "message_start", model: "test-model" },
          { type: "text_delta", text: "recovered with skills" },
          {
            type: "message_end",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ],
      },
    );

    const changing: CompactionStrategy = {
      id: "shrink",
      async compact() {
        return [makeMsg("user", "condensed")];
      },
    };

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "test-model", sessionStore: store, compaction: changing });
    const session = await agent.session();

    const si = getSessionInternals(session);
    const ai = getAgentInternals(agent);
    ai.skillListingText = "foo: does foo things";
    si.invokedSkills.push({ name: "foo", substitutedBody: "FOO SKILL BODY", invokedAt: 0 });

    const events: import("./events.js").Event[] = [];
    for await (const ev of session.run("hi")) {
      events.push(ev);
    }

    const resultEvent = events.find(e => e.type === "result") as import("./events.js").ResultEvent | undefined;
    expect(resultEvent?.subtype).toBe("success");
    expect(events.some(e => e.type === "compaction")).toBe(true);

    await agent.close();
  });

  it("rethrows ContextLengthError without re-sending when forced compaction is a no-op", async () => {
    const { ContextLengthError } = await import("./errors.js");
    const provider = new MockProvider();

    // Exactly one script: the overflow. defaultCompaction on a 1-message view
    // (fewer than 10 assistant turns) returns it unchanged, so the loop must
    // NOT make a second provider call — a re-send would hit the empty queue
    // and surface "no script enqueued" instead of ContextLengthError.
    provider.enqueue({
      events: [],
      throwBefore: new ContextLengthError("context too long"),
    });

    const store = new InMemorySessionStore();
    const agent = new Agent({ provider, model: "test-model", sessionStore: store });
    const session = await agent.session();

    const events: import("./events.js").Event[] = [];
    for await (const ev of session.run("hi")) {
      events.push(ev);
    }

    // No CompactionEvent for the no-op
    expect(events.some(e => e.type === "compaction")).toBe(false);

    // The original ContextLengthError surfaces
    const errorEvent = events.find(e => e.type === "error") as import("./events.js").ErrorEvent | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error.name).toBe("ContextLengthError");

    const resultEvent = events.find(e => e.type === "result") as import("./events.js").ResultEvent | undefined;
    expect(resultEvent?.subtype).toBe("error");

    await agent.close();
  });
});
