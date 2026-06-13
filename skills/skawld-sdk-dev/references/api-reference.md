# Skawld SDK — API Reference

Exact public signatures. Source of truth: `src/sdk.ts` (curated re-exports) and the modules it points to.

## AgentOptions

📖 Docs: https://skawld.com/docs/agent

Passed to `new Agent(opts)`. Only `provider` and `model` are required.

```ts
interface AgentOptions {
  provider: BaseProvider;                 // REQUIRED — an instantiated provider
  model: ModelId;                         // REQUIRED — model id string; no SDK default
  tools?: ToolRegistry;                   // default: defaultTools() (the 10 built-ins)
  mcpServers?: Record<string, McpServerConfig>;  // keyed by server name; tools exposed as mcp__<server>__<tool>
  permissions?: {
    mode?: PermissionMode;               // "default" | "acceptEdits" | "yolo"; default "default"
    rules?: PermissionRule[];            // evaluated in order, before mode default
    canUseTool?: CanUseTool;             // async callback for "ask" decisions
  };
  sessionStore?: SessionStore;            // default: SqliteSessionStore at .skawld/sessions.db (lazy)
  cwd?: string;                           // working dir for tools; default process.cwd()
  systemPrompt?: string;                  // appended AFTER the default system prompt
  compaction?: CompactionStrategy;        // default: built-in, triggers at 80% of context window
  maxRetries?: number;                    // retryable provider errors; default 5
  maxOutputTokens?: number;               // per-turn cap; see note below
  includePartialMessages?: boolean;       // emit partial_assistant token deltas; default false
  maxTurns?: number;                      // hard cap on turns/run; default Infinity → TurnLimitError result on hit
  cacheTtl?: "5m" | "1h";                 // Anthropic prompt-cache TTL hint; default "5m"
  configDir?: string;                     // dir for skills/agents; default ".skawld" resolved vs cwd
  hooks?: Hooks;                          // typed interception points; see building-agents.md → Hooks
  askUser?: AskUserHandler;               // enables the AskUser tool; see building-agents.md → AskUser
}
```

- **`maxOutputTokens` omitted**: OpenAI providers omit `max_tokens` from the wire (API default applies); Anthropic falls back to `32768` because its API requires the field.
- **`mcpServers`** connect lazily on the first `session()` and disconnect on `close()`. A connect failure throws from `session()`.
- **`systemPrompt`** is APPENDED — the cache-optimized default prompt stays intact. Dynamic content (date, etc.) lives in the first user message, not the system prompt.
- **`hooks`** registers typed interception points (`preToolUse`, `postToolUse`, `userPromptSubmit`, `stop`, `preCompact`). Invalid config throws `ConfigError` from the constructor. See `building-agents.md` → Hooks.
- **`askUser`** wires a handler for the `AskUser` tool; the tool is registered only when this is present. See `building-agents.md` → AskUser.

## Agent methods

```ts
class Agent {
  constructor(opts: AgentOptions);
  readonly opts: AgentOptions;
  // Create a new session, or resume one by id. First call connects MCP, loads skills + subagents.
  session(input?: { id?: string; meta?: Record<string, unknown> }): Promise<Session>;
  // Release resources: close store (if allocated) + disconnect MCP servers/child processes.
  close(): Promise<void>;
}
```

## Session & RunOptions

📖 Docs: https://skawld.com/docs/sessions · the loop: https://skawld.com/docs/concepts

```ts
class Session {
  readonly id: string;
  readonly createdAt: Date;
  readonly meta: Record<string, unknown>;
  get messageCount(): number;             // messages the provider sees (provider view, not full history)

  run(prompt: string, opts?: RunOptions): AsyncIterable<Event>;  // throws ConfigError if a run is active
  abort(reason?: unknown): void;          // cancels active run → next event is result(subtype:"aborted"); idempotent
  steer(prompt: string, opts?: { images?: RunOptions["images"] }): Promise<void>;  // inject a user message mid-run
  interrupt(): void;                      // graceful stop → result(subtype:"interrupted"); idempotent, no-op when idle
  updateMeta(patch: Record<string, unknown>): Promise<void>;     // shallow-merge into stored meta
}

interface RunOptions {
  signal?: AbortSignal;                   // chained with the session's internal controller
  maxOutputTokens?: number;               // per-run override
  temperature?: number;                   // per-run override
  images?: Array<{ data: string; mediaType: string } | { url: string }>;  // attach to the user prompt
  thinking?: ThinkingConfig;              // extended thinking; Anthropic-only
  effort?: EffortLevel;                   // effort hint; Anthropic-only
}
```

`run()` returns a fresh async iterator each call. Breaking out of the `for await` (or letting it be GC'd) cleans up the active-run state automatically.

- **`steer()`** queues a user message (FIFO) for injection at the next turn boundary as a real persisted user message — the run keeps going, it is not aborted. Throws `ConfigError` synchronously when no run is active. The returned promise resolves once the message is appended and its `UserEvent` emitted; it rejects with `AbortError` if the run ends first, or `HookError` if a `userPromptSubmit` hook blocks that message.
- **`interrupt()`** requests a graceful stop: the current turn and its in-flight tool calls finish and persist, then the run ends with `result` subtype `"interrupted"` instead of starting another model turn. Use `abort()` for an immediate cancel of an in-flight stream.

## Event union

📖 Docs: https://skawld.com/docs/events

`session.run()` yields these. Discriminate on `event.type`. (All exported as types from `@skawld/agent-sdk`.)

| `type` | Key fields | Meaning |
|---|---|---|
| `system` | `subtype:"init"`, `session_id`, `run_id`, `model`, `tools`, `permission_mode`, `cwd` | First event of a run |
| `assistant` | `message: Message`, `stop_reason` | A full assistant message (iterate `message.content` blocks) |
| `user` | `message: Message` | User/tool-result message added to history |
| `partial_assistant` | `delta` (`text` \| `thinking` \| `tool_use_input`) | Streaming token deltas (only if `includePartialMessages`) |
| `tool_call_start` | `tool_use_id`, `tool_name`, `input` | A tool call begins |
| `tool_call_end` | `tool_use_id`, `tool_name`, `is_error`, `duration_ms` | A tool call finished |
| `permission_request` | `requests[]` (`tool_use_id`, `tool_name`, `input`, `summary`) | Tool(s) need approval |
| `usage` | `usage`, `cumulative` | Token usage for the turn + running total |
| `compaction` | `messages_before/after`, `tokens_before`, `tokens_after`(=0), `strategy` | History was compacted |
| `result` | `subtype:"success"\|"aborted"\|"error"\|"interrupted"`, `stop_reason`, `total_usage`, `duration_ms`, `final_text?` | Run finished — terminal event (`"interrupted"` after `session.interrupt()`) |
| `error` | `error` (`name`, `message`, `retryable`, `cause?`) | An error surfaced |
| `hook_error` | `hook_event` (`"PreToolUse"`\|`"PostToolUse"`\|…), `message`, `tool_use_id?` | A registered hook threw or timed out |
| `skills_loaded` | `skills[]` | Skills available this session |
| `skill_invoked` | `name`, `args?`, `model_override?`, `allowed_tools?` | Model invoked a skill |
| `skill_completed` | `name`, `is_error` | Skill turn ended |
| `subagent_event` | `parent_session_id`, `subagent_run_id`, `subagent_type`, `display_name`, `event` | Wraps a child-session event (may nest) |

Guard helpers `isSubagentEvent(e)` and `isHookErrorEvent(e)` are exported. Filter a stream by `subagent_run_id` to render subagent activity in its own UI region. A steering message (from `session.steer()`) arrives as a `user` event with `subtype:"steering"`. Other `isXxx` guards exist in core but only these two are promised public.

`result` is the terminal event — break the loop when you see it. `tokens_after` in `compaction` is always `0` (no local tokenizer); the real post-compaction input count appears in the next `usage` event.

## Providers

📖 Docs: https://skawld.com/docs/providers

```ts
import {
  AnthropicProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
  BaseProvider,
} from "@skawld/agent-sdk/providers";
```

| Class | Env var | Notes |
|---|---|---|
| `AnthropicProvider` | `ANTHROPIC_API_KEY` | Supports prompt caching, extended `thinking`, `effort`, `cacheTtl`. Falls back to the Anthropic SDK's default key lookup. |
| `OpenAIChatCompletionsProvider` | `OPENAI_API_KEY` | Classic Chat Completions API. |
| `OpenAIResponsesProvider` | `OPENAI_API_KEY` | OpenAI Responses API (used by the interactive-cli example with `gpt-5`). |

Construct with no args to read the env var, e.g. `new AnthropicProvider()`. Pass an instantiated provider to `AgentOptions.provider`. `thinking`/`effort` `RunOptions` are Anthropic-only and ignored by OpenAI providers.

### Constructor options

```ts
new AnthropicProvider({
  apiKey?: string;                 // default: env ANTHROPIC_API_KEY / SDK lookup
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  thinking?: ThinkingConfig;       // provider-default; RunOptions.thinking overrides per-run
  effort?: EffortLevel;            // provider-default; RunOptions.effort overrides per-run
});

new OpenAIChatCompletionsProvider({
  apiKey?: string;                 // default: env OPENAI_API_KEY
  baseURL?: string;                // point at any OpenAI-compatible endpoint
  defaultHeaders?: Record<string, string>;
  contextWindowOverride?: (model: ModelId) => number | undefined;  // for compaction sizing
});

new OpenAIResponsesProvider({
  // ...all OpenAIChatProviderOptions, plus:
  reasoning?: OpenAIReasoningEffort | {                 // "none"|"minimal"|"low"|"medium"|"high"|"xhigh"
    effort?: OpenAIReasoningEffort;
    summary?: "auto" | "concise" | "detailed";
    previousResponseId?: "auto" | "disabled";           // "auto" uses server-side response chaining
    encryptedContent?: boolean;                          // include encrypted reasoning in stateless replay
  };
  store?: boolean;                 // false = stateless Responses requests
});
```

### OpenAI-compatible endpoints (Ollama, vLLM, Groq, DeepSeek, …)

`OpenAIChatCompletionsProvider` doubles as the client for any OpenAI-compatible server. Set `baseURL` and supply `contextWindowOverride` so compaction sizes correctly for the model:

```ts
const provider = new OpenAIChatCompletionsProvider({
  baseURL: "http://localhost:11434/v1",     // Ollama
  apiKey: "ollama",                          // any non-empty string
  contextWindowOverride: (model) => model.includes("llama3.1") ? 128_000 : 8_192,
});
new Agent({ provider, model: "llama3.1" });
```

Known context windows are built in for common OpenAI models (`gpt-5` 400k, `gpt-4.1` 1M, `gpt-4o` 128k, `o1` 200k); unknown models fall back to 128k unless overridden. Anthropic known models default to 200k.

## Errors & lifecycle

📖 Docs: errors https://skawld.com/docs/errors · compaction https://skawld.com/docs/compaction

All extend `SkawldError`, exported from `@skawld/agent-sdk`:

```ts
SkawldError, AuthError, RateLimitError, ContextLengthError,
PermissionDeniedError, ToolExecutionError, AbortError,
ProviderError, ConfigError, SkillError, HookError
```

- `ConfigError` — bad/missing config (no provider, no model, negative `maxRetries`) or a second concurrent `run()`.
- `AuthError` / `RateLimitError` / `ProviderError` — provider-side; retryable ones are auto-retried up to `maxRetries`.
- `ContextLengthError` — drives compaction; the loop retries after compacting (once per turn).
- `PermissionDeniedError` / `ToolExecutionError` — surfaced as `error` events / tool results.
- `AbortError` — from `session.abort()` or an aborted `signal`; yields `result` with `subtype:"aborted"`.
- `HookError` — a `userPromptSubmit` hook blocked a `steer()` message; rejects that `steer()` promise. Hook throws/timeouts elsewhere surface as `hook_error` events, not thrown errors.

**Aborting:** call `session.abort()` or pass a `RunOptions.signal`. The internal controller is recreated fresh per run, so aborting while idle is a no-op for the next run.

**Compaction:** `AgentOptions.compaction` (a `CompactionStrategy`) defaults to a built-in that triggers around 80% of the context window. Override only when you need custom summarization. Emits a `compaction` event when it runs.

## Common types

Forwarded from core, importable from `@skawld/agent-sdk`:

```ts
Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock,
ThinkingBlock, ImageBlock, MessageProviderMetadata,
StopReason, Usage, ModelId, PermissionMode
```

Key shapes:

```ts
interface Message { role: "user" | "assistant"; content: ContentBlock[]; }

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock;
interface TextBlock       { type: "text"; text: string; }
interface ToolUseBlock    { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | Array<TextBlock | ImageBlock>; is_error?: boolean; }
interface ThinkingBlock   { type: "thinking"; thinking: string; signature?: string; }
interface ImageBlock      { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }; }

type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "error";

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

type ModelId = string;                                   // no SDK default
type PermissionMode = "default" | "acceptEdits" | "yolo";
```

Iterate `message.content`, discriminating on `block.type`. Assistant text lives in `text` blocks; tool calls in `tool_use` blocks.

## SessionStore interface

📖 Docs: https://skawld.com/docs/sessions

Implement this to back sessions with a custom store (Postgres, Redis, …). Pass an instance as `AgentOptions.sessionStore`. Built-ins: `SqliteSessionStore`, `InMemorySessionStore` (from `@skawld/agent-sdk/sessions`).

```ts
interface SessionStore {
  create(record: { id?: string; meta?: Record<string, unknown> }): Promise<SessionRecord>;
  load(id: string): Promise<SessionRecord | undefined>;
  loadMessages(id: string): Promise<StoredMessage[]>;
  appendMessages(id: string, messages: Message[]): Promise<StoredMessage[]>;   // assign monotonic seq
  updateMeta(id: string, meta: Record<string, unknown>): Promise<SessionRecord>;
  setInvokedSkills(id: string, skills: InvokedSkillRecord[]): Promise<void>;
  list(opts?: { limit?: number; offset?: number }): Promise<SessionRecord[]>;  // most-recent first
  delete(id: string): Promise<void>;                                            // cascades messages+tasks
  // Persistent task state (used by the Task tools):
  createTask(sessionId: string, input: CreateTaskInput): Promise<Task>;
  getTask(sessionId: string, taskId: string): Promise<Task | undefined>;
  listTasks(sessionId: string): Promise<Task[]>;
  updateTask(sessionId: string, taskId: string, patch: TaskPatch): Promise<Task | undefined>;
  deleteTask(sessionId: string, taskId: string): Promise<boolean>;
  close?(): Promise<void>;                                                       // called by Agent.close()
}
```

`SessionRecord` = `{ id, created_at, updated_at, meta, invokedSkills? }`. `StoredMessage` = `{ seq, appended_at, message }`. Task types are in `tools-catalog.md`.

## Built-in tools (`defaultTools()`)

📖 Docs: https://skawld.com/docs/tools · full param tables: `tools-catalog.md`

Ten tools, registered in this order: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`.

- Scopes: `Read`/`Glob`/`Grep` are `read`; `Write`/`Edit` are `write`; `Bash` is `exec`; Task tools are session-scoped state and always permitted.
- `Edit` enforces Read-before-Edit (the model must `Read` a file first).
- Pass your own `ToolRegistry` to add/remove tools — see `building-agents.md`.
