# Skawld SDK — Building & Extending Agents

How to extend the harness: permissions, sessions/stores, custom tools, MCP, skills, subagents.

## Permissions

📖 Docs: https://skawld.com/docs/permissions

Three layers, evaluated in this order per tool call: **validation → rules (in order) → mode default**. If the result is `"ask"`, the `canUseTool` callback is consulted.

### Modes (`AgentOptions.permissions.mode`)

| Mode | Behavior |
|---|---|
| `"default"` | `read`-scope tools and Task tools auto-allowed; `write`/`exec` tools → `ask` |
| `"acceptEdits"` | as default, but `write`-scope tools auto-allowed; `exec` still asks |
| `"yolo"` | every tool auto-allowed (no prompts) |

Read-scoped tools (`Read`, `Glob`, `Grep`) and the four Task tools are **always** allowed regardless of mode.

### Rules (`AgentOptions.permissions.rules`)

Evaluated before the mode default; first match wins. Three rule kinds:

```ts
// Allow/deny by tool name (arg matching only meaningful for the Skill tool).
{ kind: "tool", tool: "Bash", decision: "deny" }
{ kind: "tool", tool: "Skill", arg: "deploy", decision: "allow" }   // arg = skill name; "*" = any

// Allow/deny by file path glob (defaults to Write+Edit unless `tools` given).
{ kind: "path", tools: ["Write", "Edit"], paths: ["src/**"], decision: "allow" }
{ kind: "path", paths: ["**/.env", "secrets/**"], decision: "deny" }

// Allow/deny Bash by command prefix or regex (prefix tokens match the start of the command).
{ kind: "bash", pattern: "git status", decision: "allow" }
{ kind: "bash", pattern: { regex: "^rm\\s+-rf" }, decision: "deny" }
```

### `canUseTool` callback

Called only when a tool resolves to `"ask"`. It must return an allow/deny decision. This is where an embedding app prompts the user.

```ts
import type { CanUseTool } from "@skawld/agent-sdk/permissions";

const canUseTool: CanUseTool = async (req, signal) => {
  // req: { tool_name, tool_use_id, input, summary, mode }
  const ok = await promptUserSomehow(req.summary);   // your UI
  return ok
    ? { behavior: "allow" }                            // optionally { behavior: "allow", updatedInput: {...} }
    : { behavior: "deny", message: "User declined." };
};

new Agent({ provider, model, permissions: { mode: "default", canUseTool } });
```

- Returning `updatedInput` re-validates against the tool's schema; invalid input → deny.
- If `canUseTool` is **absent** and a tool resolves to `"ask"`, the call is auto-denied with a clear reason. So in `"default"` mode you almost always need either rules or a callback.
- The callback receives an `AbortSignal`; honor it for cancellable prompts.

## Hooks

📖 Docs: https://skawld.com/docs/configuration

Hooks are typed, in-process interception points the engine calls at five named moments. Pass them via `AgentOptions.hooks`; each event takes an array of registrations evaluated in order. Hooks are pure functions — no I/O assumptions — and must respect `ctx.signal`.

```ts
import type { Hooks } from "@skawld/agent-sdk";

const hooks: Hooks = {
  preToolUse: [
    {
      matcher: "Bash",                       // exact name or glob ("mcp__github__*", "*"); omit = all tools
      timeoutMs: 5_000,                      // per-hook timeout; default 60_000
      hook: (input, ctx) => {
        // input: { tool_name, tool_use_id, input, summary }; ctx: { session_id, run_id, cwd, signal }
        if (/rm\s+-rf/.test(String(input.input.command))) {
          return { action: "deny", reason: "destructive command blocked" };
        }
        // other outcomes: { action: "allow" } | { action: "ask" }
        //                 | { action: "continue", updatedInput: {...} }  // rewrite, re-validated
      },
    },
  ],
  postToolUse: [
    { hook: (input) => ({ additionalContext: `linted ${input.tool_name}` }) },  // feed text back to the model
  ],
  userPromptSubmit: [
    { hook: ({ prompt, source }) => source === "steer" ? { action: "continue" } : undefined },
    // also: { action: "block", reason } to reject the prompt
  ],
  stop: [
    { hook: ({ stop_reason, stop_hook_active }) => undefined },  // { action: "block", reason } forces another turn
  ],
  preCompact: [
    { hook: ({ trigger, messages_before, tokens_before }) => { /* observational only */ } },
  ],
};

new Agent({ provider, model, hooks });
```

Per-event semantics:

| Event | When | Outcome (per hook) | Failure policy |
|---|---|---|---|
| `preToolUse` | before a tool runs (after `validate`, after permission resolution) | `deny` > `ask` > `allow` > `continue`; `updatedInput` rewrites & re-validates | **fail-closed** (throw/timeout → deny) |
| `postToolUse` | after a tool returns | `additionalContext` strings appended to the result | fail-open |
| `userPromptSubmit` | on each `run()` prompt and each `steer()` injection (`source` distinguishes) | first `block` wins; `additionalContext` accumulates | fail-open |
| `stop` | when a turn would end the run | first `block` forces another turn (`stop_hook_active` guards loops) | fail-open |
| `preCompact` | before compaction (`trigger: "threshold"\|"forced"`) | observational — return value ignored | fail-open |

- `matcher` only applies to `preToolUse`/`postToolUse`. Glob `*` matches any run of characters; case-sensitive.
- A hook that throws or exceeds `timeoutMs` emits a `hook_error` event (`isHookErrorEvent(e)`). For `preToolUse` that also denies the call; elsewhere the engine continues.
- Invalid hook config (non-array, bad `timeoutMs`, missing `hook` function) throws `ConfigError` from the `Agent` constructor.

## Sessions & stores

📖 Docs: https://skawld.com/docs/sessions

By default sessions persist to SQLite at `.skawld/sessions.db` (created lazily on first `session()`). Override with `sessionStore`.

```ts
import { InMemorySessionStore, SqliteSessionStore } from "@skawld/agent-sdk/sessions";

// Ephemeral (tests, stateless servers) — nothing touches disk.
new Agent({ provider, model, sessionStore: new InMemorySessionStore() });

// Explicit SQLite location.
new Agent({ provider, model, sessionStore: new SqliteSessionStore({ cwd: "/data" }) });
```

**Resume a session** by passing its id back:

```ts
const s1 = await agent.session();
// ... run turns; remember s1.id ...
const resumed = await agent.session({ id: s1.id });   // reloads persisted messages
```

To implement a fully custom backend, implement the `SessionStore` interface (`create`, `loadMessages`, `appendMessages`, `updateMeta`, `close`, plus task-persistence methods) exported from `@skawld/agent-sdk/sessions`.

## Custom tools

📖 Docs: https://skawld.com/docs/tools

A tool implements the `Tool` interface (from `@skawld/agent-sdk/tools`). Register it on a `ToolRegistry` and pass that as `AgentOptions.tools`.

```ts
import { defaultTools } from "@skawld/agent-sdk/tools";
import type { Tool, ToolContext, ToolResult } from "@skawld/agent-sdk/tools";

const WeatherTool: Tool<{ city: string }> = {
  name: "Weather",
  description: "Get current weather for a city.",
  scope: "read",            // "read" | "write" | "exec" — drives permissions + scheduler
  parallelSafe: true,        // safe to run concurrently with same-scope tools
  input_schema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
  validate(raw) {
    if (typeof raw.city !== "string") throw new Error("city must be a string");
    return { city: raw.city };
  },
  summarize(input) { return `Get weather for ${input.city}`; },   // shown in permission prompts
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    // ctx: { cwd, signal, fileReadTracker, sessionId, runId, sessionStore, emit? }
    const res = await fetch(`https://api.example.com/w?q=${input.city}`, { signal: ctx.signal });
    return { content: await res.text(), summary: `Weather for ${input.city}` };
  },
};

const tools = defaultTools();
tools.register(WeatherTool);   // throws ConfigError on duplicate name
new Agent({ provider, model, tools });
```

Tool authoring rules:
- **`scope`** decides permission/scheduler behavior: `read` is auto-allowed; `write`/`exec` ask unless mode/rules say otherwise. Only `exec` tools get a usable `ctx.emit` for streaming progress events.
- **`validate`** throws on bad input; it also re-validates `updatedInput` from `canUseTool`.
- **`execute`** must respect `ctx.signal` and stop ASAP when aborted.
- `ToolResult.content` is a string or an array of text/image blocks; set `is_error: true` to signal a failed call to the model.
- Build a fresh registry with `new ToolRegistry()` (also from `/tools`) to fully control the tool set instead of starting from `defaultTools()`.

## AskUser tool

📖 Docs: https://skawld.com/docs/tools

The `AskUser` tool lets the model pause mid-run to ask the user clarifying questions (ambiguous requirements, multiple valid approaches, missing context, risky choices). It is registered **only** when you pass an `askUser` handler in `AgentOptions` — the embedding app owns how the questions are presented.

```ts
import type { AskUserHandler } from "@skawld/agent-sdk";

const askUser: AskUserHandler = async (req, signal) => {
  // req: { tool_use_id, questions[] }
  // each question: { question, header (≤12 chars), options[{ label, description? }], multi_select }
  const answers = await promptUserSomehow(req.questions, signal);   // your UI
  return { answers: answers.map((selected) => ({ selected })) };    // selected: string[] of labels and/or free text
  // or decline: return { declined: true, reason: "user cancelled" };
};

new Agent({ provider, model, askUser });
```

- Each call carries 1–4 questions, each with 2–4 options. With `multi_select: false`, an answer's `selected` has exactly one entry; with `true`, one or more.
- The user can always answer with free text instead of picking an option — never expect an "Other" option in the question set.
- Returning `{ declined: true }` tells the model the user opted out; the run continues.
- The handler receives the run's `AbortSignal`; honor it for cancellable prompts.

## MCP servers

📖 Docs: https://skawld.com/docs/mcp

Connect external MCP servers via `AgentOptions.mcpServers`. Their tools are exposed to the model as `mcp__<server>__<tool>`. Servers connect on the first `session()` and disconnect on `close()`.

```ts
new Agent({
  provider, model,
  mcpServers: {
    // stdio: spawn a local server as a child process
    everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
    // streamable HTTP: remote server
    docs: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer ..." } },
  },
});
```

Config shape mirrors the Claude Agent SDK (`McpStdioServerConfig` | `McpHttpServerConfig`). stdio is assumed when `type` is absent. A connect failure throws from `session()`. For lower-level control, `connectMcpServers(configs)` is exported from `@skawld/agent-sdk` and returns an `McpConnection` (`tools`, `close()`).

## Skills

📖 Docs: https://skawld.com/docs/skills

Skills are markdown prompt-extensions auto-loaded from `<configDir>/skills/<name>/SKILL.md` (configDir defaults to `.skawld`). When skills exist, a `Skill` tool is registered so the model can invoke them. Informational skills (no `allowed_tools`, no `model`) are auto-allowed.

`SKILL.md` frontmatter (YAML keys are snake_case):

```markdown
---
name: deploy                       # optional; defaults to the directory name
description: Deploy the app.        # REQUIRED — shown in the skill listing
when_to_use: When the user says ship/deploy/release.   # optional
allowed_tools: [Bash, Read]        # optional; restricts tools for the skill's turn
arguments: [environment]           # optional named slots substituted into the body
argument_hint: "<environment>"     # optional hint shown alongside the description
model: claude-opus-4-5             # optional per-skill model override
version: 1.0.0                     # optional
disable_model_invocation: false    # when true, hidden from listing + not invokable
---

Body markdown becomes the skill's prompt. Reference $environment to use an argument slot.
```

Observe skill activity through `skills_loaded`, `skill_invoked`, and `skill_completed` events.

## Subagents

📖 Docs: https://skawld.com/docs/subagents

Subagents are loaded from `<configDir>/agents/<name>.md`. A built-in default agent always exists, so a `Subagent` tool is registered on first `session()` even with no disk agents — the model can spawn child sessions. Child-session events are wrapped in `subagent_event` (filter by `subagent_run_id`; nesting is supported).

Agent definition `<name>.md` frontmatter:

```markdown
---
name: researcher                   # optional; defaults to the filename (minus .md)
description: Researches a topic and reports findings.   # REQUIRED
tools: [Read, Grep, Glob]          # optional allowlist; omit or ["*"] = all parent tools
---

The markdown body becomes the subagent's system prompt.
```

`tools` accepts an array or a comma-separated string; permission-pattern suffixes are stripped (`"Bash(npm:*)"` → `"Bash"`) since v1 has no per-arg subagent permissions. The parent run's `thinking`/`effort` cost knobs propagate to spawned subagents.

## Custom providers

📖 Docs: https://skawld.com/docs/providers

To target a model the built-in providers don't cover, extend `BaseProvider` (from `@skawld/agent-sdk/providers`). Three members: `id`, `contextWindow(model)`, and an async `stream(req)` that yields `ProviderStreamEvent`s. The engine handles tools, permissions, sessions, and compaction — a provider only translates one request into a normalized event stream.

```ts
import { BaseProvider } from "@skawld/agent-sdk/providers";
import type { ProviderRequest, ProviderStreamEvent } from "@skawld/agent-sdk/providers";

class MyProvider extends BaseProvider {
  readonly id = "my-provider";
  contextWindow(_model: string): number { return 128_000; }   // used by compaction
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    // req: { model, system, tools, messages, max_output_tokens?, temperature?,
    //        cache_prompt?, signal, max_retries?, ... }
    yield { type: "message_start", model: req.model };
    yield { type: "text_delta", text: "Hello" };
    // For tool calls:
    //   { type: "tool_use_start", id, name }
    //   { type: "tool_use_input_delta", id, json_delta }   // streamed JSON args
    //   { type: "tool_use_end", id }
    yield {
      type: "message_end",
      stop_reason: "end_turn",          // "tool_use" when the turn ended on tool calls
      usage: { input_tokens: 10, output_tokens: 3 },
    };
  }
}
```

`ProviderStreamEvent` union: `message_start` → (`text_delta` | `thinking_delta` | `tool_use_start` | `tool_use_input_delta` | `tool_use_end`)* → `message_end`. Respect `req.signal` and throw the SDK's typed errors (`AuthError`, `RateLimitError`, `ContextLengthError`, `AbortError`, `ProviderError`) so retries and compaction behave correctly.

## Custom compaction

📖 Docs: https://skawld.com/docs/compaction

`AgentOptions.compaction` takes a `CompactionStrategy`. The default keeps the last 10 turn boundaries and summarizes everything older into one synthetic user message, triggering when projected input tokens reach 80% of the model's context window. Override only when you need different retention/summarization.

```ts
import type { CompactionStrategy, CompactionContext } from "@skawld/agent-sdk";

const keepLast6: CompactionStrategy = {
  id: "keep-last-6-turns",
  async compact({ messages, provider, model, signal }: CompactionContext): Promise<Message[]> {
    // Return a NEW array that replaces providerView. Returning `messages`
    // unchanged is a no-op (no compaction event emitted).
    return messages.slice(-12);
  },
};

new Agent({ provider, model, compaction: keepLast6 });
```

A `compaction` event fires when it runs (`tokens_after` is always `0` — the real post-compaction input count appears in the next `usage` event). Compaction rewrites the provider-visible history only; full history is preserved internally.
