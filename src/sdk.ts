/** Public main entry for the `skawld` package. Curated re-export surface. */

// Top-level classes most consumers use.
export { Agent } from "./core/agent.js";
export type { AgentOptions } from "./core/agent.js";
export { Session } from "./core/session.js";
export type { RunOptions } from "./core/session.js";

// Default tool registry helper.
export { defaultTools } from "./tools/registry.js";

// MCP client: helper + config types (so `mcpServers` configs are typeable from the main entry).
export { connectMcpServers } from "./tools/mcp/index.js";
export type {
  McpConnection, McpServerConfig, McpStdioServerConfig, McpHttpServerConfig,
} from "./tools/mcp/index.js";

// Common types (forwarded from core).
export type {
  Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, ImageBlock,
  MessageProviderMetadata, StopReason, Usage, ModelId, PermissionMode,
} from "./core/types.js";

// Events (forwarded from core).
export type {
  Event, SystemEvent, AssistantEvent, UserEvent, PartialAssistantEvent,
  ToolCallStartEvent, ToolCallEndEvent, PermissionRequestEvent, UsageEvent,
  CompactionEvent, ResultEvent, ErrorEvent,
  SkillsLoadedEvent, SkillInvokedEvent, SkillCompletedEvent,
  SubagentEvent, HookErrorEvent,
} from "./core/events.js";

// Event guards for subagent- and hook-aware UI consumers. The other isXxx
// guards aren't promised public surface; add them here if/when consumers ask.
export { isSubagentEvent, isHookErrorEvent } from "./core/events.js";

// Hooks: Agent-level interception points (passed via AgentOptions.hooks).
export type {
  Hooks, HookRegistration, HookContext,
  PreToolUseHook, PreToolUseHookInput, PreToolUseHookOutcome,
  PostToolUseHook, PostToolUseHookInput, PostToolUseHookOutcome,
  UserPromptSubmitHook, UserPromptSubmitHookInput, UserPromptSubmitHookOutcome,
  StopHook, StopHookInput, StopHookOutcome,
  PreCompactHook, PreCompactHookInput,
} from "./core/hooks.js";

// AskUser tool types (for consumers wiring their own handler).
export type {
  AskUserHandler, AskUserRequest, AskUserResponse, AskUserAnswer,
  AskUserInput, AskUserQuestion, AskUserOption,
} from "./tools/ask-user.js";

// Errors.
export {
  SkawldError, AuthError, RateLimitError, ContextLengthError,
  PermissionDeniedError, ToolExecutionError, AbortError, ProviderError, ConfigError,
  SkillError, HookError,
} from "./core/errors.js";

// Compaction strategy (importable from the main entry for ergonomics).
export type { CompactionStrategy } from "./core/compaction.js";

// Config-file loading (opt-in; the SDK never calls loadConfig automatically).
export { loadConfig } from "./config/loader.js";
export type { LoadConfigOptions, LoadedConfig } from "./config/loader.js";
export type { SkawldConfig, ConfigWarning } from "./config/schema.js";
