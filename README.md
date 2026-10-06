# Skawld Agent SDK

An open-source all-purpose TypeScript agent harness.
Embed a full agent loop — tools, sessions, permissions, streaming events, subagents — into any Node.js or Bun application with a single import.

Runs on **Node.js 18+** and **Bun 1.1+**. ESM-only.

**Full documentation:** [https://skawld.com/docs](https://skawld.com/docs)

```sh
# pick your package manager
# Bun is reccomended
bun add @skawld/agent-sdk
# npm is also supported
npm install @skawld/agent-sdk
pnpm add @skawld/agent-sdk
yarn add @skawld/agent-sdk
```

---

## Minimal usage

```ts
import { Agent } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";

const agent = new Agent({
  provider: new AnthropicProvider(),   // reads ANTHROPIC_API_KEY from env
  model: "claude-opus-4-5",
  tools: defaultTools(),
  permissions: { mode: "default" },
});

const session = await agent.session();

for await (const event of session.run("List the files in the current directory.")) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (event.type === "result") break;
}

await agent.close();
```

See [`examples/minimal-agent.ts`](./examples/minimal-agent.ts) for a complete runnable version.

---

## Interactive CLI example

[`examples/interactive-cli.ts`](./examples/interactive-cli.ts) is a small REPL that streams agent events, renders subagent activity in live boxes, and runs in `yolo` permission mode against the `OpenAIResponsesProvider`.

Setup:

```sh
export OPENAI_API_KEY=sk-...
# optional overrides
export SKAWLD_MODEL=gpt-5            # default: gpt-5
export SKAWLD_CONFIG_DIR=./.skawld   # default: ./.skawld
```

Run:

```sh
bun run examples/interactive-cli.ts
```

On startup it prompts for a working directory (defaults to the current one), then accepts free-form messages. Type `/exit` or press `Ctrl+C` to quit.

---

## Web research with Parallel Search MCP

[`examples/parallel-search-agent.ts`](./examples/parallel-search-agent.ts) connects to
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) over
Streamable HTTP, using `AgentOptions.mcpServers`. It exposes `web_search` and
`web_fetch` and asks the model to cite source URLs. Parallel's anonymous tier is
free for exploration and light use, with rate limits and no Parallel API key.
The example uses Anthropic for inference, which requires its own key and billing.

From a checkout of this repository:

```sh
bun install --frozen-lockfile
export ANTHROPIC_API_KEY=sk-ant-...
bun run examples/parallel-search-agent.ts "What is the Model Context Protocol? Cite official sources."
```

The example uses an in-memory session store, allows only the two named MCP tools,
and exposes no local filesystem or shell tools. It connects on `agent.session()`
and closes the connection in `finally`, including when a run fails. Running this
example is opt-in; it doesn't change SDK defaults or the existing examples.
To use the server in your own agent, add the following entry to `mcpServers`:

```ts
parallel: {
  type: "http",
  url: "https://search.parallel.ai/mcp",
  headers: { "User-Agent": "your-app-name/your-app-version" },
}
```

Use your application's actual name and version for the User-Agent. No
`Authorization` header is needed for anonymous access. The example sends
`skawld-sdk/parallel-search-example`. MCP calls retain the SDK's default timeout.

---

## Providers

| Provider class | Subpath | Environment variable |
|---|---|---|
| `AnthropicProvider` | `@skawld/agent-sdk/providers` | `ANTHROPIC_API_KEY` |
| `OpenAIChatCompletionsProvider` | `@skawld/agent-sdk/providers` | `OPENAI_API_KEY` |
| `OpenAIResponsesProvider` | `@skawld/agent-sdk/providers` | `OPENAI_API_KEY` |

```ts
import {
  AnthropicProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
} from "@skawld/agent-sdk/providers";
```

---

## Environment variables

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `AnthropicProvider` (falls back to SDK default lookup) |
| `OPENAI_API_KEY` | `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider` |

---

## Sessions

By default, sessions persist to SQLite at `.skawld/sessions.db`. For tests or embedded applications, pass a custom `sessionStore`, such as `InMemorySessionStore`.

```ts
import { Agent } from "@skawld/agent-sdk";
import { InMemorySessionStore } from "@skawld/agent-sdk/sessions";

const agent = new Agent({
  provider,
  model,
  sessionStore: new InMemorySessionStore(),
});
```

---

## Public API surface

```
@skawld/agent-sdk             → Agent, Session, defaultTools, MCP helpers, core types, Event types, Error classes
@skawld/agent-sdk/providers   → AnthropicProvider, OpenAIChatCompletionsProvider, OpenAIResponsesProvider, BaseProvider
@skawld/agent-sdk/tools       → ToolRegistry, defaultTools, built-in tool classes, MCP tool helpers, task types
@skawld/agent-sdk/sessions    → SqliteSessionStore, InMemorySessionStore, SessionStore and task persistence types
@skawld/agent-sdk/permissions → PermissionEngine, permission callback types, permission rule types
```

---

## License

MIT
