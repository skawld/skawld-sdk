/**
 * AnthropicProvider — uses @anthropic-ai/sdk. Translation is mostly a pass-through
 * since skawld's normalized shapes mirror Anthropic's wire format.
 *
 * Cache strategy: at most 2 cache_control breakpoints per request, well under
 * Anthropic's 4-breakpoint cap:
 *
 *   1. One on the last `cacheable: true` system block. Because the cache prefix
 *      hierarchy is `tools → system → messages`, this single breakpoint already
 *      caches the entire tools + system prefix; a separate tools breakpoint
 *      would be redundant and just spend a slot.
 *   2. One rolling breakpoint on the last content block of the most recent user
 *      message (when `cache_prompt` is true). A single rolling marker is
 *      deliberate — multiple message-level markers cause Anthropic's serving
 *      tier to retain KV-cache pages that will never be read from.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  AbortError,
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  SkawldError,
} from "../core/errors.js";
import type {
  ContentBlock,
  Message,
  ModelId,
  StopReason,
  Usage,
} from "../core/types.js";
import type { ToolSchema } from "../tools/base.js";
import {
  BaseProvider,
  type EffortLevel,
  type ProviderRequest,
  type ProviderStreamEvent,
  type SystemBlock,
  type ThinkingConfig,
} from "./base.js";
import { readRetryAfter, readStatus } from "./http-error-fields.js";
import { withRetryableStream } from "./retry.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /** Default extended-thinking config; per-run RunOptions.thinking overrides it. */
  thinking?: ThinkingConfig;
  /** Default effort hint; per-run RunOptions.effort overrides it. */
  effort?: EffortLevel;
}

const KNOWN_ANTHROPIC_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

const DEFAULT_CONTEXT = 200_000;
const MAX_CACHE_BREAKPOINTS = 4;

interface CacheControlValue {
  type: "ephemeral";
  ttl?: "1h";
}

interface CacheControl {
  cache_control?: CacheControlValue;
}

function cacheControl(ttl?: "5m" | "1h"): CacheControlValue {
  // "5m" is Anthropic's default; only emit `ttl` when "1h" is requested,
  // so the default cache_control object stays byte-identical to prior runs.
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

interface AnthropicSystemBlock extends CacheControl {
  type: "text";
  text: string;
}

interface AnthropicToolBlock extends CacheControl {
  name: string;
  description: string;
  input_schema: ToolSchema["input_schema"];
}

interface AnthropicTextContent extends CacheControl {
  type: "text";
  text: string;
}

interface AnthropicToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultContent extends CacheControl {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicTextContent | AnthropicImageContent>;
  is_error?: boolean;
}

interface AnthropicThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

interface AnthropicImageContent extends CacheControl {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

type AnthropicContent =
  | AnthropicTextContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent
  | AnthropicThinkingContent
  | AnthropicImageContent;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContent[];
}

export interface AnthropicRequestPayload {
  model: ModelId;
  system: AnthropicSystemBlock[];
  tools: AnthropicToolBlock[];
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  stop_sequences?: string[];
  thinking?: ThinkingConfig;
  output_config?: { effort: EffortLevel };
}

export function translateSystem(
  blocks: SystemBlock[],
  ttl?: "5m" | "1h",
): AnthropicSystemBlock[] {
  const out: AnthropicSystemBlock[] = blocks.map((b) => ({
    type: "text",
    text: b.text,
  }));
  // Single breakpoint on the LAST cacheable block. Anthropic's prefix cache
  // works greedily — one breakpoint at the end of the cacheable run caches
  // the entire prefix up to that point, so per-block breakpoints would just
  // waste slots without improving hit rate (all our system blocks share the
  // same stability profile).
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.cacheable) {
      const target = out[i];
      if (target) target.cache_control = cacheControl(ttl);
      break;
    }
  }
  return out;
}

export function translateTools(tools: ToolSchema[]): AnthropicToolBlock[] {
  // No tools-level cache_control. Cache prefix hierarchy is tools → system →
  // messages, so the system breakpoint above already caches the tools array
  // as part of the prefix. A separate tools breakpoint would just spend a slot.
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function translateImage(
  source: import("../core/types.js").ImageBlock["source"],
): AnthropicImageContent["source"] {
  if (source.type === "base64") {
    return { type: "base64", media_type: source.media_type, data: source.data };
  }
  return { type: "url", url: source.url };
}

function translateContent(block: ContentBlock): AnthropicContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result": {
      const content =
        typeof block.content === "string"
          ? block.content
          : block.content.map((c) =>
              c.type === "text"
                ? ({ type: "text", text: c.text } as AnthropicTextContent)
                : ({ type: "image", source: translateImage(c.source) } as AnthropicImageContent),
            );
      const out: AnthropicToolResultContent = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content,
      };
      if (block.is_error !== undefined) out.is_error = block.is_error;
      return out;
    }
    case "thinking": {
      const out: AnthropicThinkingContent = {
        type: "thinking",
        thinking: block.thinking,
      };
      if (block.signature !== undefined) out.signature = block.signature;
      return out;
    }
    case "image":
      return { type: "image", source: translateImage(block.source) };
  }
}

export function translateMessages(messages: Message[]): AnthropicMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(translateContent),
  }));
}

/**
 * Apply a single rolling cache_control breakpoint to the last content block of
 * the most recent user message. No-ops on non-user trailing messages, empty
 * content, or thinking blocks (which don't accept cache_control).
 *
 * Single rolling marker is deliberate — see header comment.
 */
export function applyConversationCacheBreakpoint(
  messages: AnthropicMessage[],
  usedBreakpoints: number,
  ttl?: "5m" | "1h",
): void {
  if (usedBreakpoints >= MAX_CACHE_BREAKPOINTS) return;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content.length === 0) return;
  const block = last.content[last.content.length - 1];
  if (!block) return;
  // thinking and tool_use blocks don't support cache_control; the rest do.
  if (block.type === "thinking" || block.type === "tool_use") return;
  block.cache_control = cacheControl(ttl);
}

export function buildPayload(
  req: ProviderRequest,
  thinking?: ThinkingConfig,
  effort?: EffortLevel,
): AnthropicRequestPayload {
  const ttl = req.cache_ttl;
  const system = translateSystem(req.system, ttl);
  const systemBreakpoints = system.filter((b) => b.cache_control).length;
  const tools = translateTools(req.tools);
  const messages = translateMessages(req.messages);
  if (req.cache_prompt) {
    applyConversationCacheBreakpoint(messages, systemBreakpoints, ttl);
  }
  const payload: AnthropicRequestPayload = {
    model: req.model,
    system,
    tools,
    messages,
    // Anthropic's Messages API requires max_tokens — when the caller didn't
    // set one (no Agent-level default + no per-run override), fall back to
    // a conservative 32768. Pass an explicit AgentOptions.maxOutputTokens
    // (or RunOptions.maxOutputTokens) to raise the cap up to the model's max.
    max_tokens: req.max_output_tokens ?? 32768,
  };
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.stop_sequences !== undefined) payload.stop_sequences = req.stop_sequences;
  if (thinking !== undefined) payload.thinking = thinking;
  if (effort !== undefined) payload.output_config = { effort };
  return payload;
}

export function mapStopReason(wire: string | null | undefined): StopReason {
  switch (wire) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
    case "refusal":
      return wire;
    default:
      return "error";
  }
}

export function mapAnthropicError(err: unknown): SkawldError {
  if (err instanceof SkawldError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AbortError(err.message, { cause: err });
  }
  const status = readStatus(err);
  const message = readMessage(err);
  if (status === 401 || status === 403) {
    return new AuthError(message, { cause: err });
  }
  if (status === 429) {
    return new RateLimitError(message, {
      retry_after_seconds: readRetryAfter(err),
      cause: err,
    });
  }
  if (status === 400) {
    if (/context|max_tokens|prompt is too long|too many tokens/i.test(message)) {
      return new ContextLengthError(message, { cause: err });
    }
    return new ProviderError(message, {
      status,
      retryable: false,
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(message, { status, retryable: true, cause: err });
  }
  // Network / unknown — treat as retryable provider error.
  return new ProviderError(message, {
    status,
    retryable: status === undefined,
    cause: err,
  });
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown };
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

interface WireStream extends AsyncIterable<unknown> {
  controller?: { abort?: () => void };
}

interface AnthropicWireClient {
  messages: {
    stream(
      params: AnthropicRequestPayload,
      options?: { signal?: AbortSignal; maxRetries?: number },
    ): WireStream;
  };
}

export class AnthropicProvider extends BaseProvider {
  readonly id = "anthropic";
  protected client: AnthropicWireClient;
  protected thinking?: ThinkingConfig;
  protected effort?: EffortLevel;

  constructor(opts: AnthropicProviderOptions = {}) {
    super();
    const init: ConstructorParameters<typeof Anthropic>[0] = {};
    if (opts.apiKey !== undefined) init.apiKey = opts.apiKey;
    if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
    if (opts.defaultHeaders !== undefined) init.defaultHeaders = opts.defaultHeaders;
    this.client = new Anthropic(init) as unknown as AnthropicWireClient;
    if (opts.thinking !== undefined) this.thinking = opts.thinking;
    if (opts.effort !== undefined) this.effort = opts.effort;
  }

  contextWindow(model: ModelId): number {
    return KNOWN_ANTHROPIC_CONTEXT[model] ?? DEFAULT_CONTEXT;
  }

  /** Test seam — production opens via SDK; tests override to inject fake events. */
  protected openStream(
    payload: AnthropicRequestPayload,
    signal: AbortSignal,
    maxRetries: number,
  ): WireStream {
    return this.client.messages.stream(payload, { signal, maxRetries });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    // Per-request value overrides the provider-level default.
    const thinking = req.thinking ?? this.thinking;
    const effort = req.effort ?? this.effort;
    const payload = buildPayload(req, thinking, effort);
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
    payload: AnthropicRequestPayload,
    req: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    let wire: WireStream | undefined;
    try {
      wire = this.openStream(payload, req.signal, 0);
    } catch (err) {
      throw mapAnthropicError(err);
    }

    try {
      yield* mapWireEvents(wire, req.model);
    } catch (err) {
      throw mapAnthropicError(err);
    } finally {
      wire.controller?.abort?.();
    }
  }
}

/* ----------- wire event mapping ------------ */

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function readUsage(u: WireUsage | undefined, prev: Usage): Usage {
  // The wire's input_tokens excludes cache reads/writes; Usage.input_tokens is
  // the cache-inclusive total prompt size (matching OpenAI semantics), with the
  // cache fields as its breakdown. prev holds the normalized total, so recover
  // the wire-level value by subtraction before re-normalizing.
  const prevWireInput =
    prev.input_tokens - (prev.cache_read_tokens ?? 0) - (prev.cache_creation_tokens ?? 0);
  const wireInput = u?.input_tokens ?? prevWireInput;
  const cr = u?.cache_read_input_tokens ?? prev.cache_read_tokens;
  const cc = u?.cache_creation_input_tokens ?? prev.cache_creation_tokens;
  const next: Usage = {
    input_tokens: wireInput + (cr ?? 0) + (cc ?? 0),
    output_tokens: u?.output_tokens ?? prev.output_tokens,
  };
  if (cr !== undefined) next.cache_read_tokens = cr;
  if (cc !== undefined) next.cache_creation_tokens = cc;
  return next;
}

export async function* mapWireEvents(
  wire: AsyncIterable<unknown>,
  model: ModelId,
): AsyncIterable<ProviderStreamEvent> {
  yield { type: "message_start", model };

  // index → tool_use id (for content_block_delta routing)
  const toolBlocks = new Map<number, string>();
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const raw of wire) {
    const ev = raw as Record<string, unknown> & { type?: string };
    switch (ev.type) {
      case "message_start": {
        const msg = (ev as { message?: { usage?: WireUsage } }).message;
        if (msg?.usage) usage = readUsage(msg.usage, usage);
        break;
      }
      case "content_block_start": {
        const e = ev as {
          index: number;
          content_block: { type: string; id?: string; name?: string };
        };
        const cb = e.content_block;
        if (cb.type === "tool_use" && cb.id && cb.name) {
          toolBlocks.set(e.index, cb.id);
          yield { type: "tool_use_start", id: cb.id, name: cb.name };
        }
        break;
      }
      case "content_block_delta": {
        const e = ev as {
          index: number;
          delta: {
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            partial_json?: string;
          };
        };
        const d = e.delta;
        if (d.type === "text_delta" && d.text) {
          yield { type: "text_delta", text: d.text };
        } else if (d.type === "thinking_delta" && d.thinking) {
          const out: ProviderStreamEvent = {
            type: "thinking_delta",
            text: d.thinking,
          };
          if (d.signature) out.signature = d.signature;
          yield out;
        } else if (d.type === "signature_delta" && d.signature) {
          yield { type: "thinking_delta", text: "", signature: d.signature };
        } else if (d.type === "input_json_delta" && d.partial_json !== undefined) {
          const id = toolBlocks.get(e.index);
          if (id) {
            yield {
              type: "tool_use_input_delta",
              id,
              json_delta: d.partial_json,
            };
          }
        }
        break;
      }
      case "content_block_stop": {
        const e = ev as { index: number };
        const id = toolBlocks.get(e.index);
        if (id) {
          yield { type: "tool_use_end", id };
          toolBlocks.delete(e.index);
        }
        break;
      }
      case "message_delta": {
        const e = ev as {
          delta?: { stop_reason?: string | null };
          usage?: WireUsage;
        };
        if (e.delta?.stop_reason !== undefined) {
          stopReason = mapStopReason(e.delta.stop_reason);
        }
        if (e.usage) usage = readUsage(e.usage, usage);
        break;
      }
      case "message_stop": {
        // emit terminal event below
        break;
      }
      default:
        // Unknown event — ignore. SDK may add new ones.
        break;
    }
  }

  yield { type: "message_end", stop_reason: stopReason, usage };
}
