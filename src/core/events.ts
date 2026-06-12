/** Closed event union emitted by a Run. */

import type { Message, ModelId, PermissionMode, StopReason, Usage } from "./types.js";

export type Event =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | PartialAssistantEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | PermissionRequestEvent
  | UsageEvent
  | CompactionEvent
  | ResultEvent
  | ErrorEvent
  | SkillsLoadedEvent
  | SkillInvokedEvent
  | SkillCompletedEvent
  | SubagentEvent
  | HookErrorEvent;

export interface SystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  run_id: string;
  model: ModelId;
  tools: string[];
  permission_mode: PermissionMode;
  cwd: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: Message;
  stop_reason: StopReason;
}

export interface UserEvent {
  type: "user";
  message: Message;
  /**
   * Optional provenance of the user message. Omitted on plain phase-1 user
   * events. `"stop_hook"` marks the system-reminder message a blocking Stop hook
   * appended; `"steering"` is emitted by module 15.
   */
  subtype?: "steering" | "stop_hook";
}

export interface PartialAssistantEvent {
  type: "partial_assistant";
  delta:
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool_use_input"; tool_use_id: string; json_delta: string };
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  duration_ms: number;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  requests: Array<{
    tool_use_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    summary: string;
  }>;
}

export interface UsageEvent {
  type: "usage";
  usage: Usage;
  cumulative: Usage;
}

export interface CompactionEvent {
  type: "compaction";
  messages_before: number;
  messages_after: number;
  tokens_before: number;
  /**
   * Always 0 at emission time — no local tokenizer is available (deferred per spec).
   * The accurate post-compaction token count appears in the next UsageEvent's
   * `usage.input_tokens` field, reported by the provider.
   */
  tokens_after: number;
  strategy: string;
  /**
   * Usage of the summarization call this compaction made, when the strategy ran
   * one (the default strategy does). Otherwise undefined. Consumers tracking
   * cost should add this to the run total — it is not folded into `total_usage`.
   */
  summary_usage?: Usage;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "aborted" | "error";
  stop_reason: StopReason;
  total_usage: Usage;
  duration_ms: number;
  final_text?: string;
}

export interface ErrorEvent {
  type: "error";
  error: {
    name: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  };
}

export interface SkillsLoadedEvent {
  type: "skills_loaded";
  skills: Array<{
    name: string;
    description: string;
    when_to_use?: string;
    argument_hint?: string;
  }>;
}

export interface SkillInvokedEvent {
  type: "skill_invoked";
  name: string;
  args?: string;
  model_override?: ModelId;
  allowed_tools?: string[];
}

export interface SkillCompletedEvent {
  type: "skill_completed";
  name: string;
  is_error: boolean;
}

/**
 * Wraps an event emitted by a child Session spawned through the `Subagent` tool.
 * Yielded into the parent Session's event iterator while the child runs, so UIs
 * can render hierarchically.
 *
 * Nested spawns produce nested SubagentEvents — the inner `event` field may
 * itself be a SubagentEvent.
 */
export interface SubagentEvent {
  type: "subagent_event";
  /** Parent Session — the one the consumer is iterating. */
  parent_session_id: string;
  /** Unique per Subagent tool call. */
  subagent_run_id: string;
  /** Agent type identifier ('researcher' | '_default' | ...). */
  subagent_type: string;
  /** UI display name. 'Researcher' for named agents, 'Agent #N' for the default. */
  display_name: string;
  /** The child Session's original event. */
  event: Event;
}

/**
 * Non-terminal event emitted when a hook throws, rejects, or exceeds its timeout.
 * Unlike {@link ErrorEvent} it is NEVER followed by a {@link ResultEvent}: the run
 * continues, and the failure's effect is already encoded in behavior (a PreToolUse
 * deny, an unchanged tool result, a normal stop). Pure observability — may appear
 * anywhere between the `system` and `result` events of a run.
 */
export interface HookErrorEvent {
  type: "hook_error";
  hook_event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "PreCompact";
  /** Error message, or "Hook timed out after <n>ms". */
  message: string;
  /** Present for tool hooks (PreToolUse / PostToolUse). */
  tool_use_id?: string;
}

export function isSystemEvent(e: Event): e is SystemEvent {
  return e.type === "system";
}
export function isAssistantEvent(e: Event): e is AssistantEvent {
  return e.type === "assistant";
}
export function isUserEvent(e: Event): e is UserEvent {
  return e.type === "user";
}
export function isPartialAssistantEvent(e: Event): e is PartialAssistantEvent {
  return e.type === "partial_assistant";
}
export function isToolCallStartEvent(e: Event): e is ToolCallStartEvent {
  return e.type === "tool_call_start";
}
export function isToolCallEndEvent(e: Event): e is ToolCallEndEvent {
  return e.type === "tool_call_end";
}
export function isPermissionRequestEvent(e: Event): e is PermissionRequestEvent {
  return e.type === "permission_request";
}
export function isUsageEvent(e: Event): e is UsageEvent {
  return e.type === "usage";
}
export function isCompactionEvent(e: Event): e is CompactionEvent {
  return e.type === "compaction";
}
export function isResultEvent(e: Event): e is ResultEvent {
  return e.type === "result";
}
export function isErrorEvent(e: Event): e is ErrorEvent {
  return e.type === "error";
}
export function isSkillsLoadedEvent(e: Event): e is SkillsLoadedEvent {
  return e.type === "skills_loaded";
}
export function isSkillInvokedEvent(e: Event): e is SkillInvokedEvent {
  return e.type === "skill_invoked";
}
export function isSkillCompletedEvent(e: Event): e is SkillCompletedEvent {
  return e.type === "skill_completed";
}
export function isSubagentEvent(e: Event): e is SubagentEvent {
  return e.type === "subagent_event";
}
export function isHookErrorEvent(e: Event): e is HookErrorEvent {
  return e.type === "hook_error";
}
