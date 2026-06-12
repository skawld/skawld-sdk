import { describe, expect, it } from "bun:test";
import type { Message } from "../core/types.js";
import type { ProviderRequest, ProviderStreamEvent } from "./base.js";
import {
  type ChatRequestPayload,
  buildPayload,
  mapStopReason,
  mapWireEvents,
  OpenAIChatCompletionsProvider,
  translateMessages,
  translateSystem,
  translateTools,
} from "./openai-chat.js";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-4o",
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

describe("translateSystem", () => {
  it("concatenates with double newlines", () => {
    expect(
      translateSystem([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
  });
});

describe("translateTools", () => {
  it("wraps in function envelope", () => {
    const out = translateTools([
      {
        name: "Bash",
        description: "Run",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(out).toEqual([
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Run",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("translateMessages", () => {
  it("coalesces assistant text + tool_use into one message", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    ];
    const out = translateMessages(msgs);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      role: "assistant",
      content: "Calling tool",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "Bash", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
  });

  it("emits null content for assistant tool-use-only turn", () => {
    const out = translateMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "X", input: {} }],
      },
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "X", arguments: "{}" } },
      ],
    });
  });

  it("drops assistant thinking blocks", () => {
    const out = translateMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "...", signature: "s" },
          { type: "text", text: "ok" },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: "assistant", content: "ok" });
  });

  it("fans out user tool_result blocks into role:tool messages", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "out1" },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: "out2" }],
          },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "t1", content: "out1" },
      { role: "tool", tool_call_id: "t2", content: "out2" },
    ]);
  });

  it("preserves text in tool message and attaches images via follow-up user message", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "header" },
              { type: "image", source: { type: "url", url: "http://x" } },
            ],
          },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "t1", content: "header" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image returned by tool call t1:" },
          { type: "image_url", image_url: { url: "http://x" } },
        ],
      },
    ]);
  });

  it("image-only tool_result stubs the tool message and forwards the image", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAA" },
              },
            ],
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "tool",
        tool_call_id: "t1",
        content: "[image returned in following user message]",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Image returned by tool call t1:" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAA" },
          },
        ],
      },
    ]);
  });

  it("user text + image becomes parts array; pure-text remains string", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "what is" },
          { type: "image", source: { type: "url", url: "http://x/y.png" } },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "hello" });
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is" },
        { type: "image_url", image_url: { url: "http://x/y.png" } },
      ],
    });
  });

  it("converts base64 image to data URL", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
        ],
      },
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    });
  });
});

describe("buildPayload", () => {
  it("prepends system message, includes stream_options for usage", () => {
    const payload: ChatRequestPayload = buildPayload(
      req({
        system: [{ type: "text", text: "be nice" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );
    expect(payload.messages[0]).toEqual({ role: "system", content: "be nice" });
    expect(payload.stream).toBe(true);
    expect(payload.stream_options.include_usage).toBe(true);
  });

  it("omits tools when empty", () => {
    expect(buildPayload(req()).tools).toBeUndefined();
  });

  it("omits max_completion_tokens from the wire when req.max_output_tokens is undefined", () => {
    const payload = buildPayload(req({ max_output_tokens: undefined }));
    expect(payload.max_completion_tokens).toBeUndefined();
    expect("max_completion_tokens" in payload).toBe(false);
  });

  it("sets max_completion_tokens on the wire when req.max_output_tokens is provided", () => {
    const payload = buildPayload(req({ max_output_tokens: 2048 }));
    expect(payload.max_completion_tokens).toBe(2048);
    // The deprecated max_tokens param must never be emitted (reasoning models reject it).
    expect("max_tokens" in payload).toBe(false);
  });
});

describe("mapStopReason", () => {
  it.each([
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["weird", "error"],
    [null, "error"],
  ])("%p → %p", (input, expected) => {
    expect(mapStopReason(input as string | null)).toBe(
      expected as ReturnType<typeof mapStopReason>,
    );
  });
});

describe("mapWireEvents", () => {
  it("emits text, tool_use bracket across split argument chunks, end", async () => {
    const chunks: unknown[] = [
      { choices: [{ delta: { content: "Sure" } }] },
      { choices: [{ delta: { content: ", " } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tc1",
                  function: { name: "Bash", arguments: '{"cm' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'd":"ls"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls", delta: {} }] },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 60 },
        },
        choices: [],
      },
    ];
    const out = await collect(mapWireEvents(fromArray(chunks), "gpt-4o"));
    expect(out).toEqual([
      { type: "message_start", model: "gpt-4o" },
      { type: "text_delta", text: "Sure" },
      { type: "text_delta", text: ", " },
      { type: "tool_use_start", id: "tc1", name: "Bash" },
      { type: "tool_use_input_delta", id: "tc1", json_delta: '{"cm' },
      { type: "tool_use_input_delta", id: "tc1", json_delta: 'd":"ls"}' },
      { type: "tool_use_end", id: "tc1" },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60 },
      },
    ]);
  });

  it("handles delayed id/name arrival on tool_calls", async () => {
    const chunks: unknown[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"a"' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "tc1", function: { name: "X", arguments: ":1}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls", delta: {} }] },
    ];
    const out = await collect(mapWireEvents(fromArray(chunks), "m"));
    // First tool_call chunk has no id+name — its args are buffered, not dropped.
    // Second chunk completes start and the buffered fragment is flushed with it.
    expect(out.filter((e) => e.type === "tool_use_start")).toEqual([
      { type: "tool_use_start", id: "tc1", name: "X" },
    ]);
    // Both the pre-start fragment and the completing chunk's args are preserved
    // (lossless accumulation), yielding the full JSON input.
    expect(out.filter((e) => e.type === "tool_use_input_delta")).toEqual([
      { type: "tool_use_input_delta", id: "tc1", json_delta: '{"a":1}' },
    ]);
  });

  it("missing prompt_tokens_details yields cache_read_tokens absent (no throw)", async () => {
    const chunks: unknown[] = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ finish_reason: "stop", delta: {} }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [] },
    ];
    const out = await collect(mapWireEvents(fromArray(chunks), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") {
      expect(end.usage.cache_read_tokens).toBeUndefined();
      expect(end.usage.input_tokens).toBe(5);
    }
  });
});

describe("OpenAIChatCompletionsProvider", () => {
  it("contextWindow precedence: override > known > default", () => {
    const p1 = new OpenAIChatCompletionsProvider({ apiKey: "x" });
    expect(p1.contextWindow("gpt-4o")).toBe(128_000);
    expect(p1.contextWindow("unknown")).toBe(128_000);

    const p2 = new OpenAIChatCompletionsProvider({
      apiKey: "x",
      contextWindowOverride: (m) => (m === "llama" ? 32_000 : undefined),
    });
    expect(p2.contextWindow("llama")).toBe(32_000);
    expect(p2.contextWindow("gpt-4o")).toBe(128_000);
  });

  it("stream() forwards payload to openStream and yields normalized events", async () => {
    class FakeProvider extends OpenAIChatCompletionsProvider {
      lastPayload?: ChatRequestPayload;
      override openStream(payload: ChatRequestPayload) {
        this.lastPayload = payload;
        const chunks: unknown[] = [
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [{ finish_reason: "stop", delta: {} }] },
        ];
        return Object.assign(fromArray(chunks), { controller: undefined });
      }
    }
    const p = new FakeProvider({ apiKey: "x" });
    const events = await collect(
      p.stream(
        req({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      ),
    );
    expect(p.lastPayload?.model).toBe("m");
    expect(events[0]).toEqual({ type: "message_start", model: "m" });
    expect(events.at(-1)).toMatchObject({ type: "message_end", stop_reason: "end_turn" });
  });
});

import { AbortError, ProviderError, RateLimitError } from "../core/errors.js";

// Retry of the initial connection (429/5xx/network) is managed by Skawld so
// all providers share the same backoff semantics. The SDK retry budget stays
// disabled; req.max_retries controls Skawld's retry loop.
describe("OpenAIChatCompletionsProvider — max_retries", () => {
  const okChunks: unknown[] = [
    { choices: [{ delta: { content: "ok" } }] },
    { choices: [{ finish_reason: "stop", delta: {} }] },
  ];

  it("disables SDK retries even when the request has max_retries", async () => {
    let captured: number | undefined;
    class CapturingProvider extends OpenAIChatCompletionsProvider {
      override openStream(
        _payload: ChatRequestPayload,
        _signal: AbortSignal,
        maxRetries: number,
      ) {
        captured = maxRetries;
        return Object.assign(fromArray(okChunks), { controller: undefined });
      }
    }
    const p = new CapturingProvider({ apiKey: "x" });
    await collect(p.stream(req({ max_retries: 3 })));
    expect(captured).toBe(0);
  });

  it("defaults to five Skawld retries when unset", async () => {
    let opens = 0;
    class RetryProvider extends OpenAIChatCompletionsProvider {
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
    class LateRateLimitProvider extends OpenAIChatCompletionsProvider {
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
    class RetryProvider extends OpenAIChatCompletionsProvider {
      override openStream() {
        opens++;
        if (opens < 3) {
          const iter = (async function* () {
            throw { status: 429, headers: { "retry-after": "0" }, message: "slow down" };
          })();
          return Object.assign(iter, { controller: undefined });
        }
        return Object.assign(fromArray(okChunks), { controller: undefined });
      }
    }
    const p = new RetryProvider({ apiKey: "x" });
    const events = await collect(p.stream(req({ max_retries: 2 })));
    expect(events.some((e) => e.type === "text_delta" && e.text === "ok")).toBe(true);
    expect(opens).toBe(3);
  });

  it("does not re-open when a streamed request fails after mapped output", async () => {
    let opens = 0;
    class OnceProvider extends OpenAIChatCompletionsProvider {
      override openStream() {
        opens++;
        const iter = (async function* () {
          yield { choices: [{ delta: { content: "partial" } }] };
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

describe("refusal mapping (D7)", () => {
  it("surfaces a streamed refusal as assistant text", async () => {
    const chunks: unknown[] = [
      { choices: [{ delta: { refusal: "I can't help with that." } }] },
      { choices: [{ finish_reason: "content_filter", delta: {} }] },
    ];
    const out = await collect(mapWireEvents(fromArray(chunks), "m"));
    expect(out).toContainEqual({ type: "text_delta", text: "I can't help with that." });
  });
});

describe("abort-aware error mapping (D1)", () => {
  it("maps a mid-stream failure to AbortError when the signal is aborted", async () => {
    const ctrl = new AbortController();
    class AbortingProvider extends OpenAIChatCompletionsProvider {
      override openStream() {
        const iter = (async function* (): AsyncGenerator<never> {
          ctrl.abort();
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
    class ResetProvider extends OpenAIChatCompletionsProvider {
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

// Steering (module 15) appends a user message after a tool-result user message.
// In Chat Completions a tool_result becomes a role:"tool" message and the
// steering text a role:"user" message — both accepted, no splicing failure.
describe("translateMessages — consecutive user messages (steering)", () => {
  it("preserves two back-to-back text user messages as separate entries", () => {
    const out = translateMessages([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "steered" }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.role === "user")).toBe(true);
    expect((out[1] as { content: string }).content).toBe("steered");
  });

  it("maps tool_result then a steering user message to tool + user entries", () => {
    const out = translateMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "also do X" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect((out[2] as { content: string }).content).toBe("also do X");
  });
});
