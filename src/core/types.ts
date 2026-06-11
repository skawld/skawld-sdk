/** Shared types: messages, content blocks, usage, stop reasons, model id, permission mode. */

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
  provider_metadata?: MessageProviderMetadata;
}

export interface MessageProviderMetadata {
  openai_responses?: {
    response_id?: string;
    output_items?: Array<Record<string, unknown>>;
  };
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "error";

export interface Usage {
  /**
   * Total prompt size, cache-inclusive. The cache fields below are subsets of
   * this value; cost accounting derives the uncached portion by subtraction
   * (`input_tokens - cache_read_tokens - cache_creation_tokens`). Providers
   * whose wire format excludes cache tokens from input (Anthropic) normalize
   * before reporting.
   */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export type ModelId = string;

export type PermissionMode = "default" | "acceptEdits" | "yolo";

/** Skill invocation record persisted with the session for compaction-safe replay. */
export interface InvokedSkillRecord {
  name: string;
  /** Exactly what the SkillTool returned as its tool_result content. */
  substitutedBody: string;
  /** Epoch ms; for telemetry only. */
  invokedAt: number;
}

/** One-turn overlay produced by SkillTool and consumed by the next provider.send. */
export interface SkillOverlay {
  /** Additive allow set; union with existing rules for the next turn only. */
  allowedTools?: string[];
  /** Model override; preserves [1m] suffix from session model when needed. */
  modelOverride?: ModelId;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0),
    cache_creation_tokens: (a.cache_creation_tokens ?? 0) + (b.cache_creation_tokens ?? 0),
  };
}
