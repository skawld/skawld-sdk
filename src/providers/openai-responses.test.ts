import { describe, expect, it } from "bun:test";
import type { Message } from "../core/types.js";
import type { ProviderRequest, ProviderStreamEvent } from "./base.js";
import {
  type ResponsesRequestPayload,
  buildPayload,
  deriveStopReason,
  mapWireEvents,
  OpenAIResponsesProvider,
  translateInput,
  translateTools,
} from "./openai-responses.js";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-5",
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

describe("translateTools", () => {
  it("emits function tools at top level (no nested function envelope)", () => {
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
        name: "Bash",
        description: "Run",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});

describe("translateInput", () => {
  it("user text → input_text in input message; tool_result → function_call_output", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "out" },
          { type: "text", text: "and then?" },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      { type: "function_call_output", call_id: "c1", output: "out" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "and then?" }],
      },
    ]);
  });

  it("assistant text + tool_use replay → output_text message + function_call item", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "c1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "calling" }],
      },
      {
        type: "function_call",
        call_id: "c1",
        name: "Bash",
        arguments: '{"cmd":"ls"}',
      },
    ]);
  });

  it("drops thinking blocks instead of treating summaries as replayable reasoning", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "with sig", signature: "s" },
          { type: "thinking", thinking: "no sig" },
        ],
      },
    ];
    const out = translateInput(msgs);
    expect(out.some((i) => i.type === "reasoning")).toBe(false);
  });

  it("replays raw OpenAI Responses output items from provider metadata", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "display summary" }],
        provider_metadata: {
          openai_responses: {
            output_items: [
              {
                type: "reasoning",
                id: "rs_1",
                summary: [{ type: "summary_text", text: "display summary" }],
                encrypted_content: "enc",
              },
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "Bash",
                arguments: "{}",
              },
            ],
          },
        },
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "display summary" }],
        encrypted_content: "enc",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "Bash",
        arguments: "{}",
      },
    ]);
  });

  it("forwards tool_result images via function_call_output content array", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAA" },
              },
            ],
          },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
    ]);
  });

  it("mixed text + image tool_result keeps both in function_call_output", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [
              { type: "text", text: "header" },
              { type: "image", source: { type: "url", url: "http://x" } },
            ],
          },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "header" },
          { type: "input_image", image_url: "http://x" },
        ],
      },
    ]);
  });

  it("converts base64 image to data URL via input_image", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
    ]);
  });
});

describe("buildPayload", () => {
  it("uses top-level instructions; omits previous_response_id when no response id exists", () => {
    const payload: ResponsesRequestPayload = buildPayload(
      req({ system: [{ type: "text", text: "be terse" }] }),
    );
    expect(payload.instructions).toBe("be terse");
    expect(
      (payload as unknown as Record<string, unknown>).previous_response_id,
    ).toBeUndefined();
  });

  it("attaches reasoning when provided", () => {
    const payload = buildPayload(req(), "medium");
    expect(payload.reasoning).toEqual({ effort: "medium" });
  });

  it("omits max_output_tokens from the wire when req.max_output_tokens is undefined", () => {
    const payload = buildPayload(req({ max_output_tokens: undefined }));
    expect(payload.max_output_tokens).toBeUndefined();
    expect("max_output_tokens" in payload).toBe(false);
  });

  it("sets max_output_tokens on the wire when req.max_output_tokens is provided", () => {
    const payload = buildPayload(req({ max_output_tokens: 2048 }));
    expect(payload.max_output_tokens).toBe(2048);
  });

  it("supports structured reasoning summaries and xhigh effort", () => {
    const payload = buildPayload(req(), { effort: "xhigh", summary: "auto" });
    expect(payload.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("uses previous_response_id and only sends messages after the prior response", () => {
    const payload = buildPayload(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "old" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
            provider_metadata: { openai_responses: { response_id: "resp_1" } },
          },
          { role: "user", content: [{ type: "text", text: "new" }] },
        ],
      }),
      "low",
    );
    expect(payload.previous_response_id).toBe("resp_1");
    expect(payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "new" }],
      },
    ]);
  });

  it("can disable response chaining and include encrypted reasoning for stateless replay", () => {
    const payload = buildPayload(
      req({
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "summary" }],
            provider_metadata: {
              openai_responses: {
                response_id: "resp_1",
                output_items: [
                  {
                    type: "reasoning",
                    id: "rs_1",
                    summary: [{ type: "summary_text", text: "summary" }],
                    encrypted_content: "enc",
                  },
                ],
              },
            },
          },
        ],
      }),
      { effort: "high", previousResponseId: "disabled" },
    );
    expect(payload.previous_response_id).toBeUndefined();
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    expect(payload.input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "summary" }],
        encrypted_content: "enc",
      },
    ]);
  });

  it("sets store=false and stateless encrypted reasoning include", () => {
    const payload = buildPayload(req(), "minimal", false);
    expect(payload.store).toBe(false);
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("stream: true always set", () => {
    expect(buildPayload(req()).stream).toBe(true);
  });
});

describe("deriveStopReason", () => {
  it.each([
    ["completed", false, undefined, "end_turn"],
    ["completed", true, undefined, "tool_use"],
    ["incomplete", false, "max_output_tokens", "max_tokens"],
    ["incomplete", false, "content_filter", "refusal"],
    ["incomplete", false, "other", "error"],
    ["weird", false, undefined, "error"],
  ])(
    "status=%p hasFn=%p reason=%p → %p",
    (status, hasFn, reason, expected) => {
      expect(
        deriveStopReason(
          status as string,
          hasFn as boolean,
          reason as string | undefined,
        ),
      ).toBe(expected as ReturnType<typeof deriveStopReason>);
    },
  );
});

describe("mapWireEvents", () => {
  it("maps text deltas, function call bracket, completed with usage", async () => {
    const events: unknown[] = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hi " },
      { type: "response.output_text.delta", delta: "there" },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Bash" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"cmd":"ls"}',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "item_1" },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 60 },
          },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "gpt-5"));
    expect(out).toEqual([
      { type: "message_start", model: "gpt-5" },
      { type: "text_delta", text: "Hi " },
      { type: "text_delta", text: "there" },
      { type: "tool_use_start", id: "call_1", name: "Bash" },
      { type: "tool_use_input_delta", id: "call_1", json_delta: '{"cmd":"ls"}' },
      { type: "tool_use_end", id: "call_1" },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30, cache_read_tokens: 60 },
      },
    ]);
  });

  it("maps reasoning_summary_text.delta → thinking_delta", async () => {
    const events: unknown[] = [
      { type: "response.reasoning_summary_text.delta", delta: "hmm" },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({ type: "thinking_delta", text: "hmm" });
  });

  it("adds response id and raw output items to message_end provider metadata", async () => {
    const output = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "hmm" }],
        encrypted_content: "enc",
      },
    ];
    const events: unknown[] = [
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out.at(-1)).toEqual({
      type: "message_end",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      provider_metadata: {
        openai_responses: {
          response_id: "resp_1",
          output_items: output,
        },
      },
    });
  });

  it("maps completed reasoning item summaries to thinking_delta when summary deltas are absent", async () => {
    const output = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "completed summary" }],
      },
    ];
    const events: unknown[] = [
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({
      type: "thinking_delta",
      text: "completed summary",
    });
  });

  it("does not duplicate completed reasoning summaries after streamed summary deltas", async () => {
    const events: unknown[] = [
      { type: "response.reasoning_summary_text.delta", delta: "streamed" },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "streamed" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "streamed" },
    ]);
  });

  it("maps reasoning_summary_text.done to thinking_delta when delta events are absent", async () => {
    const events: unknown[] = [
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        summary_index: 0,
        text: "done summary",
      },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({ type: "thinking_delta", text: "done summary" });
  });

  it("incomplete with max_output_tokens → max_tokens", async () => {
    const events: unknown[] = [
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") expect(end.stop_reason).toBe("max_tokens");
  });
});

describe("OpenAIResponsesProvider", () => {
  it("contextWindow returns known model value, falls back to 128_000", () => {
    const p = new OpenAIResponsesProvider({ apiKey: "x" });
    expect(p.contextWindow("gpt-5")).toBe(400_000);
    expect(p.contextWindow("unknown")).toBe(128_000);
  });

  it("stream() yields normalized events from openStream", async () => {
    class FakeProvider extends OpenAIResponsesProvider {
      lastPayload?: ResponsesRequestPayload;
      override openStream(payload: ResponsesRequestPayload) {
        this.lastPayload = payload;
        const events: unknown[] = [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ];
        return Object.assign(fromArray(events), { controller: undefined });
      }
    }
    const p = new FakeProvider({ apiKey: "x", reasoning: "low" });
    const events = await collect(p.stream(req({ model: "m" })));
    expect(p.lastPayload?.reasoning).toEqual({ effort: "low" });
    expect(events[0]).toEqual({ type: "message_start", model: "m" });
    expect(events.at(-1)).toMatchObject({
      type: "message_end",
      stop_reason: "end_turn",
    });
  });
});

import { AbortError, ProviderError, RateLimitError } from "../core/errors.js";

// Retry of the initial connection (429/5xx/network) is managed by Skawld so
// all providers share the same backoff semantics. The SDK retry budget stays
// disabled; req.max_retries controls Skawld's retry loop.
describe("OpenAIResponsesProvider — max_retries", () => {
  const okEvents: unknown[] = [
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];

  it("disables SDK retries even when the request has max_retries", async () => {
    let captured: number | undefined;
    class CapturingProvider extends OpenAIResponsesProvider {
      override openStream(
        _payload: ResponsesRequestPayload,
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
    class RetryProvider extends OpenAIResponsesProvider {
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
    class LateRateLimitProvider extends OpenAIResponsesProvider {
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
    class RetryProvider extends OpenAIResponsesProvider {
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
    class OnceProvider extends OpenAIResponsesProvider {
      override openStream() {
        opens++;
        const iter = (async function* () {
          yield { type: "response.output_text.delta", delta: "partial" };
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
    const events: unknown[] = [
      { type: "response.refusal.delta", delta: "I can't help with that." },
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", output: [] },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({ type: "text_delta", text: "I can't help with that." });
  });
});

describe("stateless encrypted-reasoning include (D8)", () => {
  it("includes reasoning.encrypted_content for stateless requests by default", () => {
    const payload = buildPayload(req(), { previousResponseId: "disabled" });
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("omits the include when the caller explicitly disables encrypted content", () => {
    const payload = buildPayload(req(), {
      previousResponseId: "disabled",
      encryptedContent: false,
    });
    expect(payload.include).toBeUndefined();
  });

  it("omits the include for stateful (auto) requests", () => {
    const payload = buildPayload(req(), { previousResponseId: "auto" });
    expect(payload.include).toBeUndefined();
  });
});

describe("abort-aware error mapping (D1)", () => {
  it("maps a mid-stream failure to AbortError when the signal is aborted", async () => {
    const ctrl = new AbortController();
    class AbortingProvider extends OpenAIResponsesProvider {
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
    class ResetProvider extends OpenAIResponsesProvider {
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
