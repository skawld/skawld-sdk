import { describe, expect, it } from "bun:test";
import {
  AbortError,
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
} from "../core/errors.js";
import type { Message } from "../core/types.js";
import type { ToolSchema } from "../tools/base.js";
import {
  AnthropicProvider,
  type AnthropicRequestPayload,
  applyConversationCacheBreakpoint,
  buildPayload,
  mapAnthropicError,
  mapStopReason,
  mapWireEvents,
  translateMessages,
  translateSystem,
  translateTools,
} from "./anthropic.js";
import type { ProviderRequest, ProviderStreamEvent } from "./base.js";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-opus-4-6",
    system: [],
    tools: [],
    messages: [],
    max_output_tokens: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

const sampleTool: ToolSchema = {
  name: "Bash",
  description: "Run a command",
  input_schema: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
};

describe("translateSystem", () => {
  it("passes text through unchanged when no blocks are cacheable", () => {
    const out = translateSystem([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(out).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("places exactly one cache_control on the last cacheable block", () => {
    const out = translateSystem([
      { type: "text", text: "a", cacheable: true },
      { type: "text", text: "b", cacheable: true },
      { type: "text", text: "c", cacheable: true },
    ]);
    expect(out[0]?.cache_control).toBeUndefined();
    expect(out[1]?.cache_control).toBeUndefined();
    expect(out[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips trailing non-cacheable blocks when picking the breakpoint", () => {
    const out = translateSystem([
      { type: "text", text: "a", cacheable: true },
      { type: "text", text: "b", cacheable: true },
      { type: "text", text: "c" },
    ]);
    expect(out[0]?.cache_control).toBeUndefined();
    expect(out[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(out[2]?.cache_control).toBeUndefined();
  });
});

describe("translateTools", () => {
  it("returns empty for no tools", () => {
    expect(translateTools([])).toEqual([]);
  });

  it("never annotates tools with cache_control", () => {
    const t2: ToolSchema = { ...sampleTool, name: "Read" };
    const out = translateTools([sampleTool, t2]);
    expect(out[0]?.cache_control).toBeUndefined();
    expect(out[1]?.cache_control).toBeUndefined();
  });
});

describe("translateMessages", () => {
  it("maps text, tool_use, tool_result, thinking, image", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          { type: "thinking", thinking: "...", signature: "sig" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "out" }],
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
          { type: "image", source: { type: "url", url: "https://x/y.png" } },
        ],
      },
    ];
    const out = translateMessages(messages);
    expect(out[0]?.content[0]).toEqual({ type: "text", text: "hi" });
    expect(out[0]?.content[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { cmd: "ls" },
    });
    expect(out[0]?.content[2]).toEqual({
      type: "thinking",
      thinking: "...",
      signature: "sig",
    });
    expect(out[1]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "out" }],
    });
    expect(out[1]?.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAA" },
    });
    expect(out[1]?.content[2]).toEqual({
      type: "image",
      source: { type: "url", url: "https://x/y.png" },
    });
  });

  it("passes through tool_result string content", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "raw" }],
      },
    ]);
    expect(out[0]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "raw",
    });
  });
});

describe("applyConversationCacheBreakpoint", () => {
  it("annotates the last content block of the most recent user message", () => {
    const msgs = translateMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "x" },
          { type: "tool_result", tool_use_id: "b", content: "y" },
        ],
      },
    ]);
    applyConversationCacheBreakpoint(msgs, 0);
    const last = msgs[0]?.content[1];
    expect(last && "cache_control" in last && last.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("works on a text-only user message (turn 1, no tool_result)", () => {
    const msgs = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "<env>" },
          { type: "text", text: "hello" },
        ],
      },
    ]);
    applyConversationCacheBreakpoint(msgs, 0);
    const last = msgs[0]?.content[1];
    expect(last && "cache_control" in last && last.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("no-ops when the last message is from the assistant", () => {
    const msgs = translateMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    applyConversationCacheBreakpoint(msgs, 0);
    const block = msgs[1]?.content[0];
    expect(block && "cache_control" in block && block.cache_control).toBeFalsy();
  });

  it("no-ops when budget exhausted", () => {
    const msgs = translateMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "x" }],
      },
    ]);
    applyConversationCacheBreakpoint(msgs, 4);
    const c = msgs[0]?.content[0];
    expect(c && "cache_control" in c && c.cache_control).toBeFalsy();
  });

  it("never places cache_control on a trailing thinking block", () => {
    // Anthropic rejects cache_control on thinking blocks; the breakpoint must
    // be skipped rather than land on one.
    const msgs = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "thinking", thinking: "...", signature: "sig" },
        ],
      },
    ]);
    applyConversationCacheBreakpoint(msgs, 0);
    const block = msgs[0]?.content[1];
    expect(block && "cache_control" in block && block.cache_control).toBeFalsy();
  });
});

describe("buildPayload", () => {
  it("falls back to max_tokens=32768 when req.max_output_tokens is undefined (API requires the field)", () => {
    const payload = buildPayload(req({ max_output_tokens: undefined }));
    expect(payload.max_tokens).toBe(32768);
  });

  it("respects req.max_output_tokens when set", () => {
    const payload = buildPayload(req({ max_output_tokens: 4096 }));
    expect(payload.max_tokens).toBe(4096);
  });

  it("uses at most 2 breakpoints: one on last cacheable system block, one on last user message", () => {
    const payload = buildPayload(
      req({
        system: [
          { type: "text", text: "a", cacheable: true },
          { type: "text", text: "b", cacheable: true },
          { type: "text", text: "c", cacheable: true },
        ],
        tools: [sampleTool],
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "r" }],
          },
        ],
        cache_prompt: true,
      }),
    );
    // system: only the last cacheable block carries the BP.
    expect(payload.system[0]?.cache_control).toBeUndefined();
    expect(payload.system[1]?.cache_control).toBeUndefined();
    expect(payload.system[2]?.cache_control).toEqual({ type: "ephemeral" });
    // tools: never carry cache_control under the new strategy.
    expect(payload.tools[0]?.cache_control).toBeUndefined();
    // conversation: rolling BP on the last content block.
    const tr = payload.messages[0]?.content[0];
    expect(tr && "cache_control" in tr && tr.cache_control).toEqual({
      type: "ephemeral",
    });
    const totalBreakpoints =
      payload.system.filter((s) => s.cache_control).length +
      payload.tools.filter((t) => t.cache_control).length +
      payload.messages.reduce(
        (n, m) =>
          n +
          m.content.filter(
            (c) => "cache_control" in c && c.cache_control,
          ).length,
        0,
      );
    expect(totalBreakpoints).toBe(2);
  });

  it("emits ttl:'1h' on every breakpoint when cache_ttl is '1h'", () => {
    const payload = buildPayload(
      req({
        system: [{ type: "text", text: "a", cacheable: true }],
        tools: [sampleTool],
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "r" }],
          },
        ],
        cache_prompt: true,
        cache_ttl: "1h",
      }),
    );
    expect(payload.system[0]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(payload.tools[0]?.cache_control).toBeUndefined();
    const tr = payload.messages[0]?.content[0];
    expect(tr && "cache_control" in tr && tr.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("omits ttl key when cache_ttl is '5m' or undefined (default ephemeral)", () => {
    const payload = buildPayload(
      req({
        system: [{ type: "text", text: "a", cacheable: true }],
        tools: [sampleTool],
        cache_prompt: true,
        cache_ttl: "5m",
      }),
    );
    expect(payload.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(payload.tools[0]?.cache_control).toBeUndefined();
  });

  it("omits temperature and stop_sequences when not provided", () => {
    const payload: AnthropicRequestPayload = buildPayload(req());
    expect(payload.temperature).toBeUndefined();
    expect(payload.stop_sequences).toBeUndefined();
  });

  it("omits thinking and output_config when not provided", () => {
    const payload = buildPayload(req());
    expect(payload.thinking).toBeUndefined();
    expect(payload.output_config).toBeUndefined();
  });

  it("passes thinking through verbatim and maps effort to output_config", () => {
    const payload = buildPayload(
      req(),
      { type: "enabled", budget_tokens: 4000, display: "omitted" },
      "xhigh",
    );
    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4000,
      display: "omitted",
    });
    expect(payload.output_config).toEqual({ effort: "xhigh" });
  });

  it("supports adaptive and disabled thinking shapes", () => {
    expect(buildPayload(req(), { type: "adaptive" }).thinking).toEqual({
      type: "adaptive",
    });
    expect(buildPayload(req(), { type: "disabled" }).thinking).toEqual({
      type: "disabled",
    });
  });
});

describe("mapStopReason", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["refusal", "refusal"],
    ["weird", "error"],
    [null, "error"],
    [undefined, "error"],
  ])("maps %p → %p", (input, expected) => {
    expect(mapStopReason(input as string | null | undefined)).toBe(
      expected as ReturnType<typeof mapStopReason>,
    );
  });
});

describe("mapAnthropicError", () => {
  it("401 → AuthError", () => {
    const err = mapAnthropicError({ status: 401, message: "nope" });
    expect(err).toBeInstanceOf(AuthError);
  });
  it("429 → RateLimitError with retry-after", () => {
    const err = mapAnthropicError({
      status: 429,
      message: "slow",
      headers: { "retry-after": "12" },
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retry_after_seconds).toBe(12);
  });
  it("400 with context_length → ContextLengthError", () => {
    const err = mapAnthropicError({
      status: 400,
      message: "prompt is too long for context window",
    });
    expect(err).toBeInstanceOf(ContextLengthError);
  });
  it("400 other → ProviderError non-retryable", () => {
    const err = mapAnthropicError({ status: 400, message: "bad input" });
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });
  it("502 → ProviderError retryable", () => {
    const err = mapAnthropicError({ status: 502, message: "bad gateway" });
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
  it("AbortError name → AbortError", () => {
    const raw = new Error("aborted");
    raw.name = "AbortError";
    expect(mapAnthropicError(raw)).toBeInstanceOf(AbortError);
  });
  it("network (no status) → retryable ProviderError", () => {
    const err = mapAnthropicError({ message: "ECONNRESET" });
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe("mapWireEvents", () => {
  it("emits start, text, tool_use bracket, end with usage", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: { id: "m1", usage: { input_tokens: 10, output_tokens: 0 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "there" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu1", name: "Bash" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"cmd\":" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "\"ls\"}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 42 },
      },
      { type: "message_stop" },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "claude-test"));
    expect(out).toEqual([
      { type: "message_start", model: "claude-test" },
      { type: "text_delta", text: "Hi " },
      { type: "text_delta", text: "there" },
      { type: "tool_use_start", id: "tu1", name: "Bash" },
      { type: "tool_use_input_delta", id: "tu1", json_delta: "{\"cmd\":" },
      { type: "tool_use_input_delta", id: "tu1", json_delta: "\"ls\"}" },
      { type: "tool_use_end", id: "tu1" },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 42 },
      },
    ]);
  });

  it("emits thinking_delta with signature", async () => {
    const events: unknown[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({ type: "thinking_delta", text: "hmm" });
    expect(out).toContainEqual({
      type: "thinking_delta",
      text: "",
      signature: "sig",
    });
  });

  it("propagates cache_read_input_tokens to usage.cache_read_tokens", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") {
      expect(end.usage.cache_read_tokens).toBe(100);
      expect(end.usage.cache_creation_tokens).toBe(20);
      // input_tokens is normalized to the cache-inclusive total prompt size
      expect(end.usage.input_tokens).toBe(125);
    }
  });

  it("normalizes input_tokens to include cache tokens from message_delta usage", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 800,
          output_tokens: 7,
          cache_read_input_tokens: 149_000,
          cache_creation_input_tokens: 2_000,
        },
      },
      { type: "message_stop" },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") {
      expect(end.usage.input_tokens).toBe(151_800);
      expect(end.usage.cache_read_tokens).toBe(149_000);
      expect(end.usage.cache_creation_tokens).toBe(2_000);
      expect(end.usage.output_tokens).toBe(7);
    }
  });

  it("keeps the normalized total when a later delta omits input fields", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 800,
            output_tokens: 0,
            cache_read_input_tokens: 149_000,
            cache_creation_input_tokens: 2_000,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") {
      expect(end.usage.input_tokens).toBe(151_800);
      expect(end.usage.output_tokens).toBe(3);
    }
  });
});

describe("AnthropicProvider", () => {
  it("contextWindow returns known value, falls back to 200_000", () => {
    const p = new AnthropicProvider({ apiKey: "x" });
    expect(p.contextWindow("claude-opus-4-6")).toBe(200_000);
    expect(p.contextWindow("unknown-model")).toBe(200_000);
  });

  it("stream() runs payload through openStream and yields normalized events", async () => {
    class FakeProvider extends AnthropicProvider {
      lastPayload?: AnthropicRequestPayload;
      override openStream(
        payload: AnthropicRequestPayload,
        _signal: AbortSignal,
      ) {
        this.lastPayload = payload;
        const events: unknown[] = [
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ];
        return Object.assign(fromArray(events), { controller: undefined });
      }
    }
    const p = new FakeProvider({ apiKey: "x" });
    const events = await collect(p.stream(req({ model: "m" })));
    expect(p.lastPayload?.model).toBe("m");
    expect(events[0]).toEqual({ type: "message_start", model: "m" });
    expect(events.at(-1)).toMatchObject({ type: "message_end", stop_reason: "end_turn" });
  });

  describe("thinking/effort defaults and overrides", () => {
    class CapturingProvider extends AnthropicProvider {
      lastPayload?: AnthropicRequestPayload;
      override openStream(payload: AnthropicRequestPayload) {
        this.lastPayload = payload;
        const events: unknown[] = [
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ];
        return Object.assign(fromArray(events), { controller: undefined });
      }
    }

    it("applies constructor-level thinking and effort defaults", async () => {
      const p = new CapturingProvider({
        apiKey: "x",
        thinking: { type: "adaptive" },
        effort: "low",
      });
      await collect(p.stream(req()));
      expect(p.lastPayload?.thinking).toEqual({ type: "adaptive" });
      expect(p.lastPayload?.output_config).toEqual({ effort: "low" });
    });

    it("per-request thinking and effort override the constructor defaults", async () => {
      const p = new CapturingProvider({
        apiKey: "x",
        thinking: { type: "adaptive" },
        effort: "low",
      });
      await collect(
        p.stream(
          req({
            thinking: { type: "enabled", budget_tokens: 8000 },
            effort: "max",
          }),
        ),
      );
      expect(p.lastPayload?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 8000,
      });
      expect(p.lastPayload?.output_config).toEqual({ effort: "max" });
    });

    it("omits both when neither configured nor requested", async () => {
      const p = new CapturingProvider({ apiKey: "x" });
      await collect(p.stream(req()));
      expect(p.lastPayload?.thinking).toBeUndefined();
      expect(p.lastPayload?.output_config).toBeUndefined();
    });
  });

  it("translates SDK errors via mapAnthropicError", async () => {
    class FailingProvider extends AnthropicProvider {
      override openStream(): never {
        throw { status: 401, message: "no key" };
      }
    }
    const p = new FailingProvider({ apiKey: "x" });
    await expect(
      (async () => {
        for await (const _ev of p.stream(req())) void _ev;
      })(),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("calls wire.controller.abort() on early exit", async () => {
    let aborted = false;
    class FakeProvider extends AnthropicProvider {
      override openStream() {
        const events: unknown[] = [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "a" },
          },
        ];
        return Object.assign(fromArray(events), {
          controller: {
            abort: () => {
              aborted = true;
            },
          },
        });
      }
    }
    const p = new FakeProvider({ apiKey: "x" });
    for await (const _ev of p.stream(req())) {
      // exit after first text_delta to simulate early-cancel
      if (_ev.type === "text_delta") break;
    }
    expect(aborted).toBe(true);
  });

  // Retry of the initial connection (429/5xx/network) is managed by Skawld so
  // all providers share the same backoff semantics. The SDK retry budget stays
  // disabled; req.max_retries controls Skawld's retry loop.
  const okEvents: unknown[] = [
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];

  it("disables SDK retries even when the request has max_retries", async () => {
    let captured: number | undefined;
    class CapturingProvider extends AnthropicProvider {
      override openStream(
        _payload: AnthropicRequestPayload,
        _signal: AbortSignal,
        maxRetries: number,
      ) {
        captured = maxRetries;
        return Object.assign(fromArray(okEvents), { controller: undefined });
      }
    }
    const p = new CapturingProvider({ apiKey: "x" });
    await collect(p.stream(req({ max_retries: 3 })));
    expect(captured).toBe(0);
  });

  it("defaults to five Skawld retries when unset", async () => {
    let opens = 0;
    class RetryProvider extends AnthropicProvider {
      override openStream() {
        opens++;
        const iter = (async function* () {
          throw { status: 429, headers: { "retry-after": "0" }, message: "slow down" };
        })();
        return Object.assign(iter, { controller: undefined });
      }
    }
    const p = new RetryProvider({ apiKey: "x" });
    await expect(collect(p.stream(req()))).rejects.toBeInstanceOf(RateLimitError);
    expect(opens).toBe(6);
  });

  it("uses request max_retries as the Skawld retry budget", async () => {
    let opens = 0;
    class LateRateLimitProvider extends AnthropicProvider {
      override openStream() {
        opens++;
        const iter = (async function* () {
          throw { status: 429, headers: { "retry-after": "0" }, message: "slow down" };
        })();
        return Object.assign(iter, { controller: undefined });
      }
    }
    const p = new LateRateLimitProvider({ apiKey: "x" });
    await expect(
      (async () => {
        for await (const _ev of p.stream(req({ max_retries: 2 }))) void _ev;
      })(),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(opens).toBe(3);
  });

  it("re-opens when a retryable failure occurs before mapped output", async () => {
    let opens = 0;
    class RetryProvider extends AnthropicProvider {
      override openStream() {
        opens++;
        if (opens < 3) {
          const iter = (async function* () {
            throw { status: 429, headers: { "retry-after": "0" }, message: "slow down" };
          })();
          return Object.assign(iter, { controller: undefined });
        }
        return Object.assign(fromArray(okEvents), { controller: undefined });
      }
    }
    const p = new RetryProvider({ apiKey: "x" });
    const events = await collect(p.stream(req({ max_retries: 2 })));
    expect(events.some((e) => e.type === "text_delta" && e.text === "ok")).toBe(true);
    expect(opens).toBe(3);
  });

  it("does not re-open when a streamed request fails after mapped output", async () => {
    let opens = 0;
    class OnceProvider extends AnthropicProvider {
      override openStream() {
        opens++;
        const iter = (async function* () {
          yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
          throw { status: 503, message: "unavailable" };
        })();
        return Object.assign(iter, { controller: undefined });
      }
    }
    const p = new OnceProvider({ apiKey: "x" });
    await expect(
      (async () => {
        for await (const _ev of p.stream(req({ max_retries: 5 }))) void _ev;
      })(),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(opens).toBe(1);
  });
});

describe("abort-aware error mapping (D1)", () => {
  it("maps a mid-stream failure to AbortError when the signal is aborted", async () => {
    const ctrl = new AbortController();
    class AbortingProvider extends AnthropicProvider {
      override openStream() {
        const iter = (async function* (): AsyncGenerator<never> {
          ctrl.abort();
          // Vendor SDK abort shape: a plain Error, name "Error", no status.
          throw new Error("Request was aborted.");
        })();
        return Object.assign(iter, { controller: undefined });
      }
    }
    const p = new AbortingProvider({ apiKey: "x" });
    await expect(
      (async () => {
        for await (const _ev of p.stream(req({ signal: ctrl.signal, max_retries: 0 }))) void _ev;
      })(),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("maps the same error shape to a retryable ProviderError when not aborted", async () => {
    class ResetProvider extends AnthropicProvider {
      override openStream() {
        const iter = (async function* (): AsyncGenerator<never> {
          throw new Error("Connection reset.");
        })();
        return Object.assign(iter, { controller: undefined });
      }
    }
    const p = new ResetProvider({ apiKey: "x" });
    await expect(
      (async () => {
        for await (const _ev of p.stream(req({ max_retries: 0 }))) void _ev;
      })(),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("premature-close guard (D2)", () => {
  it("throws a retryable ProviderError when the stream ends before a terminal event", async () => {
    const events: unknown[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      // no message_delta(stop_reason) and no message_stop
    ];
    const out: ProviderStreamEvent[] = [];
    let err: unknown;
    try {
      for await (const ev of mapWireEvents(fromArray(events), "m")) out.push(ev);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect(out.some((e) => e.type === "message_end")).toBe(false);
  });

  it("does not throw when a terminal event is present", async () => {
    const events: unknown[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out.at(-1)).toMatchObject({ type: "message_end", stop_reason: "end_turn" });
  });
});

describe("redacted_thinking round-trip (D6)", () => {
  it("captures the block on the message_end metadata and replays it before tool_use", async () => {
    const events: unknown[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "ENC" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "Bash" },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") {
      expect(end.provider_metadata?.anthropic?.redacted_thinking).toEqual([
        { type: "redacted_thinking", data: "ENC" },
      ]);
    }

    const translated = translateMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        provider_metadata: {
          anthropic: { redacted_thinking: [{ type: "redacted_thinking", data: "ENC" }] },
        },
      },
    ]);
    expect(translated[0]?.content[0]).toEqual({ type: "redacted_thinking", data: "ENC" });
    expect(translated[0]?.content[1]?.type).toBe("tool_use");
  });
});

// Steering (module 15) appends a user message after a tool-result user message,
// producing two consecutive user messages. The Anthropic adapter must preserve
// both as separate user-role entries.
describe("translateMessages — consecutive user messages (steering)", () => {
  it("preserves two back-to-back user messages as separate entries", () => {
    const translated = translateMessages([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "steered" }] },
    ]);
    expect(translated).toHaveLength(2);
    expect(translated[0]?.role).toBe("user");
    expect(translated[1]?.role).toBe("user");
    expect(translated[1]?.content[0]).toEqual({ type: "text", text: "steered" });
  });

  it("never splices a user message between tool_use and its tool_result", () => {
    const translated = translateMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "also do X" }] },
    ]);
    expect(translated.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    expect(translated[1]?.content[0]?.type).toBe("tool_result");
    expect(translated[2]?.content[0]).toEqual({ type: "text", text: "also do X" });
  });
});
