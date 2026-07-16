/**
 * OpenAIResponsesProvider. System blocks live in top-level `instructions`.
 * Function tools live at the top level (not nested under `function`). Tool calls
 * use call_id, which we normalize to `id` in ProviderStreamEvent so the engine
 * has one identifier across providers.
 */

import OpenAI from "openai";
import type {
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
import type { OpenAIChatProviderOptions } from "./openai-chat.js";
import { mapOpenAIError } from "./openai-errors.js";
import { withRetryableStream } from "./retry.js";
import { tolerantSseFetch } from "./sse-tolerance.js";

export interface OpenAIResponsesProviderOptions extends OpenAIChatProviderOptions {
  /** Reasoning effort hint or config. */
  reasoning?: OpenAIResponsesReasoningOption;
  /** Set false for stateless Responses requests. */
  store?: boolean;
}

export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

export type OpenAIResponsesReasoningOption =
  | OpenAIReasoningEffort
  | {
      effort?: OpenAIReasoningEffort;
      summary?: OpenAIReasoningSummary;
      /**
       * "auto" uses previous_response_id when a prior OpenAI Responses id is
       * available. "disabled" keeps full-history stateless replay.
       */
      previousResponseId?: "auto" | "disabled";
      /** Include encrypted reasoning content in stateless replay responses. */
      encryptedContent?: boolean;
    };

const KNOWN_OPENAI_RESPONSES_CONTEXT: Record<string, number> = {
  "gpt-5": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  o1: 200_000,
};

const DEFAULT_CONTEXT = 128_000;

/* ----------- wire input items ----------- */

interface InputTextPart {
  type: "input_text";
  text: string;
}
interface OutputTextPart {
  type: "output_text";
  text: string;
}
interface InputImagePart {
  type: "input_image";
  image_url: string;
}

type MessageContentPart = InputTextPart | OutputTextPart | InputImagePart;

interface InputMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: MessageContentPart[];
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: "in_progress" | "completed" | "incomplete";
}

interface FunctionCallOutputContentText {
  type: "input_text";
  text: string;
}
interface FunctionCallOutputContentImage {
  type: "input_image";
  image_url: string;
}
type FunctionCallOutputContent =
  | FunctionCallOutputContentText
  | FunctionCallOutputContentImage;

interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string | FunctionCallOutputContent[];
}

interface ReasoningItem {
  type: "reasoning";
  id?: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
  status?: "in_progress" | "completed" | "incomplete";
}

type RawInputItem = Record<string, unknown> & { type: string };

type InputItem =
  | InputMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | RawInputItem;

interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: ToolSchema["input_schema"];
}

export interface ResponsesRequestPayload {
  model: ModelId;
  instructions?: string;
  input: InputItem[];
  tools?: ResponsesFunctionTool[];
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: { effort?: OpenAIReasoningEffort; summary?: OpenAIReasoningSummary };
  previous_response_id?: string;
  include?: Array<"reasoning.encrypted_content">;
  store?: boolean;
  stream: true;
}

interface NormalizedResponsesOptions {
  effort?: OpenAIReasoningEffort;
  summary?: OpenAIReasoningSummary;
  previousResponseId: "auto" | "disabled";
  encryptedContent?: boolean;
  store?: boolean;
}

/* ----------- translation ----------- */

export function translateInstructions(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

export function translateTools(tools: ToolSchema[]): ResponsesFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function normalizeResponsesOptions(
  reasoning?: OpenAIResponsesReasoningOption,
  store?: boolean,
): NormalizedResponsesOptions {
  const out: NormalizedResponsesOptions = {
    previousResponseId: store === false ? "disabled" : "auto",
  };
  if (typeof reasoning === "string") {
    out.effort = reasoning;
  } else if (reasoning !== undefined) {
    if (reasoning.effort !== undefined) out.effort = reasoning.effort;
    if (reasoning.summary !== undefined) out.summary = reasoning.summary;
    if (reasoning.previousResponseId !== undefined) {
      out.previousResponseId = reasoning.previousResponseId;
    }
    if (reasoning.encryptedContent !== undefined) {
      out.encryptedContent = reasoning.encryptedContent;
    }
  }
  if (store !== undefined) out.store = store;
  return out;
}

function hasReasoningConfig(opts: NormalizedResponsesOptions): boolean {
  return opts.effort !== undefined || opts.summary !== undefined;
}

function imageToUrl(source: ImageBlock["source"]): string {
  if (source.type === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

function toolResultToOutput(
  content: import("../core/types.js").ToolResultBlock["content"],
): string | FunctionCallOutputContent[] {
  if (typeof content === "string") return content;
  // If there are no images, preserve the simpler string form.
  if (!content.some((c) => c.type === "image")) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
  }
  // Mixed or image-only: emit content array. The Responses API accepts
  // input_text / input_image items inside function_call_output.output.
  return content.map<FunctionCallOutputContent>((c) =>
    c.type === "text"
      ? { type: "input_text", text: c.text }
      : { type: "input_image", image_url: imageToUrl(c.source) },
  );
}

export function translateInput(messages: Message[]): InputItem[] {
  const out: InputItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const rawItems = msg.provider_metadata?.openai_responses?.output_items;
      if (rawItems !== undefined && rawItems.length > 0) {
        out.push(...rawItems.map((item) => item as RawInputItem));
        continue;
      }
      const parts: OutputTextPart[] = [];
      const calls: FunctionCallItem[] = [];
      for (const b of msg.content) {
        if (b.type === "text") parts.push({ type: "output_text", text: b.text });
        else if (b.type === "tool_use") {
          calls.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          });
        }
      }
      if (parts.length > 0) {
        out.push({ type: "message", role: "assistant", content: parts });
      }
      for (const c of calls) out.push(c);
    } else {
      // user: tool_result blocks become function_call_output items; text/image
      // blocks become an input message.
      const inputParts: MessageContentPart[] = [];
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          out.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: toolResultToOutput(b.content),
          });
        } else if (b.type === "text") {
          inputParts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          inputParts.push({ type: "input_image", image_url: imageToUrl(b.source) });
        }
      }
      if (inputParts.length > 0) {
        out.push({ type: "message", role: "user", content: inputParts });
      }
    }
  }
  return out;
}

function findPreviousResponse(messages: Message[]): { id: string; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.provider_metadata?.openai_responses?.response_id;
    if (id !== undefined) return { id, index: i };
  }
  return undefined;
}

export function buildPayload(
  req: ProviderRequest,
  reasoning?: OpenAIResponsesReasoningOption,
  store?: boolean,
): ResponsesRequestPayload {
  const opts = normalizeResponsesOptions(reasoning, store);
  const previous =
    opts.previousResponseId === "auto" ? findPreviousResponse(req.messages) : undefined;
  const inputMessages =
    previous !== undefined ? req.messages.slice(previous.index + 1) : req.messages;
  const payload: ResponsesRequestPayload = {
    model: req.model,
    input: translateInput(inputMessages),
    stream: true,
  };
  // Omit `max_output_tokens` when unspecified so the model's API default applies.
  if (req.max_output_tokens !== undefined) payload.max_output_tokens = req.max_output_tokens;
  if (previous !== undefined) payload.previous_response_id = previous.id;
  const instructions = translateInstructions(req.system);
  if (instructions.length > 0) payload.instructions = instructions;
  if (req.tools.length > 0) payload.tools = translateTools(req.tools);
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (opts.store !== undefined) payload.store = opts.store;
  if (hasReasoningConfig(opts)) {
    payload.reasoning = {};
    if (opts.effort !== undefined) payload.reasoning.effort = opts.effort;
    if (opts.summary !== undefined) payload.reasoning.summary = opts.summary;
  }
  // Reasoning models reason even without an explicit reasoning config, so
  // stateless multi-turn tool use must replay reasoning items with their
  // encrypted_content or the API rejects them. Default the include on for
  // stateless requests unless the caller explicitly opts out.
  const statelessReasoning =
    opts.previousResponseId === "disabled" && (opts.encryptedContent ?? true);
  if (statelessReasoning) payload.include = ["reasoning.encrypted_content"];
  return payload;
}

/* ----------- stop reason derivation ----------- */

export function deriveStopReason(
  status: string | undefined,
  hasFunctionCall: boolean,
  incompleteReason?: string,
): StopReason {
  if (status === "completed") return hasFunctionCall ? "tool_use" : "end_turn";
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "refusal";
    return "error";
  }
  return "error";
}

/* ----------- usage ----------- */

interface WireResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface WireResponseOutputItem {
  type?: string;
  [key: string]: unknown;
}

function reasoningSummaryText(item: WireResponseOutputItem | undefined): string | undefined {
  if (item?.type !== "reasoning") return undefined;
  const summary = item.summary;
  if (!Array.isArray(summary)) return undefined;
  const text = summary
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "summary_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function buildUsage(u: WireResponseUsage | undefined): Usage {
  const out: Usage = {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
  };
  const cached = u?.input_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cache_read_tokens = cached;
  return out;
}

/* ----------- wire event mapping ----------- */

export async function* mapWireEvents(
  wire: AsyncIterable<unknown>,
  model: ModelId,
): AsyncIterable<ProviderStreamEvent> {
  yield { type: "message_start", model };

  // item_id → call_id (Responses uses item_id during stream; we expose call_id as id)
  const itemToCallId = new Map<string, string>();
  let hasFunctionCall = false;
  let stopReason: StopReason = "end_turn";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let responseId: string | undefined;
  let outputItems: WireResponseOutputItem[] | undefined;
  let sawReasoningSummaryDelta = false;
  const emittedReasoningSummaryIds = new Set<string>();
  const emittedReasoningSummaryKeys = new Set<string>();

  for await (const raw of wire) {
    const ev = raw as { type?: string } & Record<string, unknown>;
    switch (ev.type) {
      case "response.created":
      case "response.in_progress":
        break;
      case "response.output_item.added": {
        const item = (ev as { item?: { type?: string; id?: string; call_id?: string; name?: string } }).item;
        if (item?.type === "function_call" && item.id && item.call_id && item.name) {
          itemToCallId.set(item.id, item.call_id);
          hasFunctionCall = true;
          yield { type: "tool_use_start", id: item.call_id, name: item.name };
        }
        break;
      }
      case "response.output_text.delta": {
        const e = ev as { delta?: string };
        if (e.delta) yield { type: "text_delta", text: e.delta };
        break;
      }
      case "response.refusal.delta": {
        // Surface refusal text as assistant text so consumers see why nothing
        // else came back, instead of an empty end_turn turn.
        const e = ev as { delta?: string };
        if (e.delta) yield { type: "text_delta", text: e.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning.delta": {
        const e = ev as { delta?: string };
        if (e.delta) {
          sawReasoningSummaryDelta = true;
          yield { type: "thinking_delta", text: e.delta };
        }
        break;
      }
      case "response.reasoning_summary_text.done": {
        const e = ev as { item_id?: string; summary_index?: number; text?: string };
        const key = `${e.item_id ?? ""}:${e.summary_index ?? ""}`;
        if (!sawReasoningSummaryDelta && e.text && !emittedReasoningSummaryKeys.has(key)) {
          emittedReasoningSummaryKeys.add(key);
          yield { type: "thinking_delta", text: e.text };
        }
        break;
      }
      case "response.reasoning_summary_part.done": {
        const e = ev as {
          item_id?: string;
          summary_index?: number;
          part?: { type?: string; text?: string };
        };
        const key = `${e.item_id ?? ""}:${e.summary_index ?? ""}`;
        if (
          !sawReasoningSummaryDelta &&
          e.part?.type === "summary_text" &&
          e.part.text &&
          !emittedReasoningSummaryKeys.has(key)
        ) {
          emittedReasoningSummaryKeys.add(key);
          yield { type: "thinking_delta", text: e.part.text };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const e = ev as { item_id?: string; delta?: string };
        if (e.item_id && e.delta !== undefined) {
          const callId = itemToCallId.get(e.item_id);
          if (callId) {
            yield {
              type: "tool_use_input_delta",
              id: callId,
              json_delta: e.delta,
            };
          }
        }
        break;
      }
      case "response.output_item.done": {
        const item = (ev as { item?: WireResponseOutputItem & { id?: string } }).item;
        if (item?.type === "function_call" && item.id) {
          const callId = itemToCallId.get(item.id);
          if (callId) {
            yield { type: "tool_use_end", id: callId };
            itemToCallId.delete(item.id);
          }
        } else if (item?.type === "reasoning" && !sawReasoningSummaryDelta) {
          const text = reasoningSummaryText(item);
          if (text !== undefined) {
            if (item.id) emittedReasoningSummaryIds.add(item.id);
            yield { type: "thinking_delta", text };
          }
        }
        break;
      }
      case "response.completed": {
        const r = (ev as {
          response?: {
            id?: string;
            status?: string;
            incomplete_details?: { reason?: string };
            usage?: WireResponseUsage;
            output?: WireResponseOutputItem[];
          };
        }).response;
        responseId = r?.id;
        outputItems = r?.output;
        if (!sawReasoningSummaryDelta) {
          for (const item of outputItems ?? []) {
            const id = typeof item.id === "string" ? item.id : undefined;
            if (id !== undefined && emittedReasoningSummaryIds.has(id)) continue;
            const text = reasoningSummaryText(item);
            if (text !== undefined) {
              if (id !== undefined) emittedReasoningSummaryIds.add(id);
              yield { type: "thinking_delta", text };
            }
          }
        }
        stopReason = deriveStopReason(
          r?.status,
          hasFunctionCall,
          r?.incomplete_details?.reason,
        );
        usage = buildUsage(r?.usage);
        break;
      }
      case "response.failed":
      case "response.incomplete": {
        const r = (ev as {
          response?: {
            id?: string;
            status?: string;
            incomplete_details?: { reason?: string };
            usage?: WireResponseUsage;
            output?: WireResponseOutputItem[];
          };
        }).response;
        responseId = r?.id;
        outputItems = r?.output;
        stopReason = deriveStopReason(
          r?.status ?? "incomplete",
          hasFunctionCall,
          r?.incomplete_details?.reason,
        );
        usage = buildUsage(r?.usage);
        break;
      }
      default:
        // Unknown / new event — ignore.
        break;
    }
  }

  const provider_metadata =
    responseId !== undefined || (outputItems !== undefined && outputItems.length > 0)
      ? {
          openai_responses: {
            ...(responseId !== undefined ? { response_id: responseId } : {}),
            ...(outputItems !== undefined && outputItems.length > 0
              ? { output_items: outputItems as Array<Record<string, unknown>> }
              : {}),
          },
        }
      : undefined;

  yield {
    type: "message_end",
    stop_reason: stopReason,
    usage,
    ...(provider_metadata !== undefined ? { provider_metadata } : {}),
  };
}

/* ----------- provider ----------- */

interface WireStream extends AsyncIterable<unknown> {
  controller?: { abort?: () => void };
}

interface OpenAIWireClient {
  responses: {
    stream(
      params: ResponsesRequestPayload,
      options?: { signal?: AbortSignal; maxRetries?: number },
    ): WireStream;
  };
}

export class OpenAIResponsesProvider extends BaseProvider {
  readonly id = "openai-responses";
  protected client: OpenAIWireClient;
  protected reasoning?: OpenAIResponsesReasoningOption;
  protected store?: boolean;

  constructor(opts: OpenAIResponsesProviderOptions = {}) {
    super();
    const init: ConstructorParameters<typeof OpenAI>[0] = {};
    if (opts.apiKey !== undefined) init.apiKey = opts.apiKey;
    if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
    if (opts.defaultHeaders !== undefined) init.defaultHeaders = opts.defaultHeaders;
    if (opts.tolerantStreaming !== false) {
      init.fetch = tolerantSseFetch({ onMalformedEvent: opts.onMalformedEvent });
    }
    this.client = new OpenAI(init) as unknown as OpenAIWireClient;
    if (opts.reasoning) this.reasoning = opts.reasoning;
    if (opts.store !== undefined) this.store = opts.store;
  }

  contextWindow(model: ModelId): number {
    return KNOWN_OPENAI_RESPONSES_CONTEXT[model] ?? DEFAULT_CONTEXT;
  }

  protected openStream(
    payload: ResponsesRequestPayload,
    signal: AbortSignal,
    maxRetries: number,
  ): WireStream {
    return this.client.responses.stream(payload, { signal, maxRetries });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const payload = buildPayload(req, this.reasoning, this.store);
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
    payload: ResponsesRequestPayload,
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
