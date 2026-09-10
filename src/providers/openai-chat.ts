/**
 * OpenAIChatCompletionsProvider — also serves as the base for OpenAI-compatible
 * endpoints (Ollama, vLLM, Groq, DeepSeek) via baseURL + contextWindowOverride.
 *
 * Translation is the heavy lift: ContentBlocks from one assistant turn fan into
 * separate wire messages, tool_use blocks coalesce under one assistant message's
 * tool_calls, and tool_result blocks become role:"tool" messages.
 */

import OpenAI from "openai";
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ModelId,
  StopReason,
  Usage,
} from "../core/types.js";
import type { ToolSchema } from "../tools/base.js";
import {
  BaseProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
  type SystemBlock,
} from "./base.js";
import { AbortError } from "../core/errors.js";
import { mapOpenAIError } from "./openai-errors.js";
import { withRetryableStream } from "./retry.js";
import { tolerantSseFetch, type MalformedEventHandler } from "./sse-tolerance.js";

export interface OpenAIChatProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /** Override context window lookup, for compatible endpoints. */
  contextWindowOverride?: (model: ModelId) => number | undefined;
  /**
   * Repair/drop malformed SSE frames (mis-wrapped keepalives, raw control
   * chars) instead of letting one bad frame abort the run. Default: true.
   */
  tolerantStreaming?: boolean;
  /** Called with the raw text of each dropped SSE event; must not throw. */
  onMalformedEvent?: MalformedEventHandler;
}

const KNOWN_OPENAI_CONTEXT: Record<string, number> = {
  "gpt-5": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  o1: 200_000,
};

const DEFAULT_CONTEXT = 128_000;

/* ------- wire shapes (kept local to avoid SDK type churn in tests) ------- */

interface ChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolSchema["input_schema"];
  };
}

interface SystemMessage {
  role: "system";
  content: string;
}

interface UserContentPartText {
  type: "text";
  text: string;
}
interface UserContentPartImage {
  type: "image_url";
  image_url: { url: string };
}
type UserContentPart = UserContentPartText | UserContentPartImage;

interface UserMessage {
  role: "user";
  content: string | UserContentPart[];
}

interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: AssistantToolCall[];
}

interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ChatRequestPayload {
  model: ModelId;
  messages: ChatMessage[];
  tools?: ChatFunctionTool[];
  // `max_completion_tokens` supersedes the deprecated `max_tokens`, which
  // reasoning models (o-series/gpt-5) reject outright.
  max_completion_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream: true;
  stream_options: { include_usage: true };
}

/* ----------- translation ----------- */

export function translateSystem(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

export function translateTools(tools: ToolSchema[]): ChatFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function imageToUrl(source: ImageBlock["source"]): string {
  if (source.type === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

function toolResultContentToString(
  content: import("../core/types.js").ToolResultBlock["content"],
): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("\n");
  if (text.length > 0) return text;
  // Image-only result: stub so the tool message isn't empty. Chat Completions
  // tool messages can't carry images directly — the bytes are attached as a
  // follow-up user message (see translateMessages).
  if (content.some((c) => c.type === "image")) {
    return "[image returned in following user message]";
  }
  return "";
}

function extractToolResultImages(
  content: import("../core/types.js").ToolResultBlock["content"],
): ImageBlock[] {
  if (typeof content === "string") return [];
  return content.filter((c): c is ImageBlock => c.type === "image");
}

function translateUserBlocks(blocks: ContentBlock[]): UserContentPart[] {
  const parts: UserContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image")
      parts.push({ type: "image_url", image_url: { url: imageToUrl(b.source) } });
  }
  return parts;
}

export function translateMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: AssistantToolCall[] = [];
      for (const b of msg.content) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
        // thinking dropped: not accepted on input
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      out.push(assistant);
    } else {
      // user: tool_result blocks fan out into role:"tool" messages. Any images
      // returned by tools are attached in a follow-up user message because Chat
      // Completions tool messages don't accept image content. Free-standing
      // text/image blocks become a final user message as before.
      const nonResult: ContentBlock[] = [];
      const toolImages: Array<{ id: string; image: ImageBlock }> = [];
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: toolResultContentToString(b.content),
          });
          for (const img of extractToolResultImages(b.content)) {
            toolImages.push({ id: b.tool_use_id, image: img });
          }
        } else {
          nonResult.push(b);
        }
      }
      if (toolImages.length > 0) {
        const parts: UserContentPart[] = [];
        for (const { id, image } of toolImages) {
          parts.push({ type: "text", text: `Image returned by tool call ${id}:` });
          parts.push({ type: "image_url", image_url: { url: imageToUrl(image.source) } });
        }
        out.push({ role: "user", content: parts });
      }
      if (nonResult.length > 0) {
        const parts = translateUserBlocks(nonResult);
        out.push({
          role: "user",
          content:
            parts.length === 1 && parts[0]?.type === "text"
              ? parts[0].text
              : parts,
        });
      }
    }
  }
  return out;
}

export function buildPayload(req: ProviderRequest): ChatRequestPayload {
  const messages: ChatMessage[] = [];
  if (req.system.length > 0) {
    messages.push({ role: "system", content: translateSystem(req.system) });
  }
  messages.push(...translateMessages(req.messages));
  const payload: ChatRequestPayload = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Omit `max_completion_tokens` when unspecified so the model's API default applies.
  if (req.max_output_tokens !== undefined) payload.max_completion_tokens = req.max_output_tokens;
  if (req.tools.length > 0) payload.tools = translateTools(req.tools);
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.stop_sequences !== undefined) payload.stop = req.stop_sequences;
  return payload;
}

export function mapStopReason(wire: string | null | undefined): StopReason {
  switch (wire) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "error";
  }
}

/* ----------- stream event mapping ----------- */

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ToolCallSlot {
  id: string;
  name: string;
  emittedStart: boolean;
  /** Argument fragments received before id+name completed, flushed on start. */
  pendingArgs: string;
}

interface WireToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoiceDelta {
  content?: string | null;
  refusal?: string | null;
  tool_calls?: WireToolCallDelta[];
}

function buildUsage(u: WireUsage | undefined): Usage {
  const out: Usage = {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
  };
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cache_read_tokens = cached;
  return out;
}

export async function* mapWireEvents(
  wire: AsyncIterable<unknown>,
  model: ModelId,
): AsyncIterable<ProviderStreamEvent> {
  yield { type: "message_start", model };

  const slots = new Map<number, ToolCallSlot>();
  let stopReason: StopReason = "end_turn";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const raw of wire) {
    const chunk = raw as {
      choices?: Array<{
        delta?: WireChoiceDelta;
        finish_reason?: string | null;
      }>;
      usage?: WireUsage;
    };

    if (chunk.usage) usage = buildUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      }
      // Surface refusal text as assistant text so consumers see why nothing
      // else came back, instead of an empty end_turn turn.
      if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
        yield { type: "text_delta", text: delta.refusal };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let slot = slots.get(tc.index);
          if (!slot) {
            slot = { id: "", name: "", emittedStart: false, pendingArgs: "" };
            slots.set(tc.index, slot);
          }
          if (!slot.emittedStart) {
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (slot.id && slot.name) {
              slot.emittedStart = true;
              yield { type: "tool_use_start", id: slot.id, name: slot.name };
              // Flush any fragments buffered before the slot was complete.
              const args = slot.pendingArgs + (tc.function?.arguments ?? "");
              slot.pendingArgs = "";
              if (args) {
                yield { type: "tool_use_input_delta", id: slot.id, json_delta: args };
              }
            } else if (tc.function?.arguments) {
              slot.pendingArgs += tc.function.arguments;
            }
          } else if (tc.function?.arguments) {
            yield {
              type: "tool_use_input_delta",
              id: slot.id,
              json_delta: tc.function.arguments,
            };
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason);
      const indices = [...slots.keys()].sort((a, b) => a - b);
      for (const i of indices) {
        const s = slots.get(i);
        if (s?.emittedStart) yield { type: "tool_use_end", id: s.id };
      }
    }
  }

  yield { type: "message_end", stop_reason: stopReason, usage };
}

/* ----------- provider ----------- */

interface WireStream extends AsyncIterable<unknown> {
  controller?: { abort?: () => void };
}

interface OpenAIWireClient {
  chat: {
    completions: {
      stream(
        params: ChatRequestPayload,
        options?: { signal?: AbortSignal; maxRetries?: number },
      ): WireStream;
    };
  };
}

export class OpenAIChatCompletionsProvider extends BaseProvider {
  readonly id = "openai-chat";
  protected client: OpenAIWireClient;
  protected contextWindowOverride?: (model: ModelId) => number | undefined;

  constructor(opts: OpenAIChatProviderOptions = {}) {
    super();
    const init: ConstructorParameters<typeof OpenAI>[0] = {};
    if (opts.apiKey !== undefined) init.apiKey = opts.apiKey;
    if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
    if (opts.defaultHeaders !== undefined) init.defaultHeaders = opts.defaultHeaders;
    if (opts.tolerantStreaming !== false) {
      init.fetch = tolerantSseFetch({ onMalformedEvent: opts.onMalformedEvent });
    }
    this.client = new OpenAI(init) as unknown as OpenAIWireClient;
    if (opts.contextWindowOverride) {
      this.contextWindowOverride = opts.contextWindowOverride;
    }
  }

  contextWindow(model: ModelId): number {
    return (
      this.contextWindowOverride?.(model) ??
      KNOWN_OPENAI_CONTEXT[model] ??
      DEFAULT_CONTEXT
    );
  }

  protected openStream(
    payload: ChatRequestPayload,
    signal: AbortSignal,
    maxRetries: number,
  ): WireStream {
    return this.client.chat.completions.stream(payload, { signal, maxRetries });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const payload = buildPayload(req);
    yield* withRetryableStream(
      () => this.streamAttempt(payload, req),
      {
        maxRetries: req.max_retries,
        shouldCommit: (ev) => (ev as ProviderStreamEvent).type !== "message_start",
      },
      req.signal,
    );
  }

  private async *streamAttempt(
    payload: ChatRequestPayload,
    req: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    let wire: WireStream | undefined;
    try {
      wire = this.openStream(payload, req.signal, 0);
    } catch (err) {
      throw mapOpenAIError(err);
    }

    try {
      yield* mapWireEvents(wire, req.model);
    } catch (err) {
      // A user abort mid-stream arrives as an SDK error whose name/status don't
      // identify it; check the request signal so a clean cancel maps to
      // AbortError, not a retryable ProviderError.
      if (req.signal.aborted) throw new AbortError("request aborted", { cause: err });
      throw mapOpenAIError(err);
    } finally {
      wire.controller?.abort?.();
    }
  }
}
