# Skawld SDK — Recipes

📖 Docs: https://skawld.com/docs/quickstart (full index: https://skawld.com/docs)

Copy-paste patterns. All imports are from the four public subpaths. Runnable examples ship in the repo's `examples/` (`minimal-agent.ts`, `mcp-agent.ts`, `interactive-cli.ts`).

## 1. Stream assistant text + tool activity

```ts
import { Agent } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";

const agent = new Agent({ provider: new AnthropicProvider(), model: "claude-opus-4-5", tools: defaultTools() });
const session = await agent.session();

for await (const event of session.run("Summarize this repo.")) {
  switch (event.type) {
    case "assistant":
      for (const b of event.message.content) if (b.type === "text") process.stdout.write(b.text);
      break;
    case "tool_call_start": console.log(`\n[tool] ${event.tool_name}`, event.input); break;
    case "tool_call_end":   console.log(`[done] ${event.tool_name} (${event.duration_ms}ms)`); break;
    case "usage":           /* event.usage / event.cumulative */ break;
    case "result":          console.log(`\n[${event.subtype}] ${event.duration_ms}ms`); break;
    case "error":           console.error("\n", event.error.message); break;
  }
  if (event.type === "result") break;
}
await agent.close();
```

## 2. Token-level streaming (typewriter)

Set `includePartialMessages: true`, then consume `partial_assistant` deltas:

```ts
const agent = new Agent({ provider, model, includePartialMessages: true });
for await (const event of session.run(prompt)) {
  if (event.type === "partial_assistant" && event.delta.kind === "text") {
    process.stdout.write(event.delta.text);          // also "thinking" and "tool_use_input" kinds
  }
  if (event.type === "result") break;
}
```

## 3. Permission prompt via canUseTool (terminal)

```ts
import { createInterface } from "node:readline/promises";
import type { CanUseTool } from "@skawld/agent-sdk/permissions";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const canUseTool: CanUseTool = async (req) => {
  const answer = await rl.question(`Allow ${req.tool_name}? ${req.summary} [y/N] `);
  return answer.trim().toLowerCase() === "y"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "User denied." };
};

const agent = new Agent({ provider, model, permissions: { mode: "default", canUseTool } });
```

## 4. Permission rules (no prompts)

Auto-allow safe operations, deny dangerous ones, ask for the rest:

```ts
const agent = new Agent({
  provider, model,
  permissions: {
    mode: "default",
    rules: [
      { kind: "bash", pattern: "git status", decision: "allow" },
      { kind: "bash", pattern: { regex: "^rm\\s+-rf" }, decision: "deny" },
      { kind: "path", paths: ["**/.env", "secrets/**"], decision: "deny" },   // Write+Edit
      { kind: "path", tools: ["Write", "Edit"], paths: ["src/**"], decision: "allow" },
    ],
    canUseTool,   // consulted only for tools that still resolve to "ask"
  },
});
```

## 5. Resume a persisted session

```ts
const agent = new Agent({ provider, model });   // default SqliteSessionStore at .skawld/sessions.db

const first = await agent.session();
for await (const e of first.run("Remember the number 42.")) if (e.type === "result") break;
const id = first.id;
await agent.close();

// later / another process:
const agent2 = new Agent({ provider, model });
const resumed = await agent2.session({ id });    // reloads history
for await (const e of resumed.run("What number did I ask you to remember?")) {
  if (e.type === "assistant") for (const b of e.message.content) if (b.type === "text") process.stdout.write(b.text);
  if (e.type === "result") break;
}
await agent2.close();
```

## 6. Abort a run

```ts
const session = await agent.session();
const iter = session.run("Do something long...");

setTimeout(() => session.abort("user cancelled"), 2000);   // or pass RunOptions.signal

for await (const event of iter) {
  if (event.type === "result") {
    console.log(event.subtype);   // "aborted"
    break;
  }
}
```

`AbortSignal` alternative: `session.run(prompt, { signal: controller.signal })`.

## 7. Images, thinking, effort, temperature (RunOptions)

```ts
for await (const e of session.run("What's in this screenshot?", {
  images: [{ data: base64Png, mediaType: "image/png" }],   // or { url: "https://..." }
  temperature: 0.2,
  thinking: { type: "enabled", budget_tokens: 4000 },       // Anthropic-only
  effort: "high",                                            // Anthropic-only
  maxOutputTokens: 8000,
})) {
  if (e.type === "result") break;
}
```

## 8. MCP-backed agent

```ts
const agent = new Agent({
  provider: new AnthropicProvider(), model: "claude-opus-4-5",
  mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] } },
});
const session = await agent.session();   // connects the MCP server here
for await (const e of session.run("Use the MCP tools to echo 'hi'.")) {
  if (e.type === "tool_call_start") console.log(e.tool_name);   // e.g. mcp__everything__echo
  if (e.type === "result") break;
}
await agent.close();   // disconnects servers + kills child processes
```

## 9. Interactive REPL skeleton (yolo + OpenAI Responses)

Mirrors `examples/interactive-cli.ts`. Note `permissions: { mode: "yolo" }` skips all prompts — use only for trusted local testing.

```ts
import { createInterface } from "node:readline/promises";
import { Agent } from "@skawld/agent-sdk";
import { OpenAIResponsesProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";

const agent = new Agent({
  provider: new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY!, reasoning: { effort: "medium" } }),
  model: process.env.SKAWLD_MODEL ?? "gpt-5",
  tools: defaultTools(),
  permissions: { mode: "yolo" },
});
const session = await agent.session();
const rl = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
  const prompt = await rl.question("> ");
  if (prompt === "/exit") break;
  for await (const e of session.run(prompt)) {
    if (e.type === "assistant") for (const b of e.message.content) if (b.type === "text") process.stdout.write(b.text);
    if (e.type === "subagent_event") { /* render child activity, keyed by e.subagent_run_id */ }
    if (e.type === "result") { process.stdout.write("\n"); break; }
  }
}
await agent.close();
rl.close();
```

## 10. Handle errors & retries

```ts
import { RateLimitError, ContextLengthError, AuthError } from "@skawld/agent-sdk";

try {
  for await (const e of session.run(prompt)) {
    if (e.type === "error") {
      // retryable errors are auto-retried up to AgentOptions.maxRetries (default 5)
      console.error(e.error.name, e.error.message, "retryable:", e.error.retryable);
    }
    if (e.type === "result") break;
  }
} catch (err) {
  if (err instanceof AuthError) { /* bad/missing API key */ }
  else if (err instanceof RateLimitError) { /* exhausted retries */ }
  else if (err instanceof ContextLengthError) { /* compaction couldn't recover */ }
  else throw err;
}
```

## 11. Test an agent app without API calls

Drive the agent with a tiny scriptable `BaseProvider` + `InMemorySessionStore` — deterministic, offline, fast. Assert on the event stream.

```ts
import { Agent } from "@skawld/agent-sdk";
import { BaseProvider } from "@skawld/agent-sdk/providers";
import type { ProviderRequest, ProviderStreamEvent } from "@skawld/agent-sdk/providers";
import { InMemorySessionStore } from "@skawld/agent-sdk/sessions";

class ScriptedProvider extends BaseProvider {
  readonly id = "scripted";
  constructor(private reply: string) { super(); }
  contextWindow() { return 200_000; }
  async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    yield { type: "message_start", model: "test" };
    yield { type: "text_delta", text: this.reply };
    yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
  }
}

const agent = new Agent({
  provider: new ScriptedProvider("hello world"),
  model: "test",
  sessionStore: new InMemorySessionStore(),   // nothing touches disk
  permissions: { mode: "yolo" },
});
const session = await agent.session();

let text = "";
for await (const e of session.run("hi")) {
  if (e.type === "assistant") for (const b of e.message.content) if (b.type === "text") text += b.text;
  if (e.type === "result") break;
}
// expect(text).toBe("hello world");
await agent.close();
```

To test tool-calling flows, emit `tool_use_start` / `tool_use_input_delta` / `tool_use_end` on the first turn (`stop_reason: "tool_use"`), then a second scripted turn for after the tool result. To test permissions, supply a `canUseTool` that returns canned decisions and assert on `permission_request` / `tool_call_end.is_error`.

## 12. Steer & interrupt an active run

`steer()` injects a message without aborting; `interrupt()` stops gracefully after the current turn. Both require an active run.

```ts
const session = await agent.session();
const iter = session.run("Refactor the auth module.");

// Inject extra guidance mid-run — resolves once it's appended as a user message.
setTimeout(() => {
  session.steer("Also keep the public API backward-compatible.").catch(() => {
    /* rejects with AbortError if the run ends first, or HookError if a userPromptSubmit hook blocks it */
  });
}, 1000);

// Ask the run to wind down cleanly after the current turn.
setTimeout(() => session.interrupt(), 5000);

for await (const event of iter) {
  if (event.type === "user" && event.subtype === "steering") console.log("[steered in]");
  if (event.type === "result") {
    console.log(event.subtype);   // "interrupted" once interrupt() takes effect
    break;
  }
}
```

`abort()` is still the immediate, hard cancel; `interrupt()` lets the in-flight turn and its tool calls finish and persist first.

## 13. Hooks + AskUser

Wire `hooks` to gate/observe tool calls and `askUser` to let the model ask the user clarifying questions:

```ts
import type { Hooks, AskUserHandler } from "@skawld/agent-sdk";

const hooks: Hooks = {
  preToolUse: [{
    matcher: "Bash",
    hook: ({ input }) =>
      /rm\s+-rf/.test(String(input.command)) ? { action: "deny", reason: "blocked" } : undefined,
  }],
  postToolUse: [{ hook: ({ tool_name }) => ({ additionalContext: `ran ${tool_name}` }) }],
};

const askUser: AskUserHandler = async (req) => ({
  answers: req.questions.map((q) => ({ selected: [q.options[0].label] })),   // your UI here
  // or: return { declined: true };
});

const agent = new Agent({ provider, model, hooks, askUser });

for await (const e of (await agent.session()).run("Set up the project the way I'd want.")) {
  if (e.type === "hook_error") console.warn(`[hook ${e.hook_event}] ${e.message}`);
  if (e.type === "result") break;
}
```

## Gotchas

- **No default model** — always pass `model`.
- **Always `await agent.close()`** — leaks SQLite handles / MCP child processes otherwise.
- **One active run per session** — a second `run()` before the first iterator finishes throws `ConfigError`; use another session for parallel turns.
- **Break on `result`** — it is the terminal event; iterating past it does nothing useful.
- **`yolo` mode disables all permission prompts** — never use it for untrusted prompts/inputs.
- **Engine prints nothing** — all output comes from events you consume.
