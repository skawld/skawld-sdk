# Skawld SDK — Consumer Project Setup

📖 Docs: install https://skawld.com/docs/install · quickstart https://skawld.com/docs/quickstart

How to set up a fresh app that depends on `@skawld/agent-sdk`. The package is **ESM-only** and ships NodeNext-clean `.d.ts`. Getting module resolution right is step 0.

## Install

```sh
bun add @skawld/agent-sdk        # Bun recommended
# or
npm install @skawld/agent-sdk
pnpm add @skawld/agent-sdk
yarn add @skawld/agent-sdk
```

Runs on **Node.js 18+** or **Bun 1.1+**.

## package.json

Mark the app as ESM. There is no CommonJS build — `require()` will not work.

```jsonc
{
  "name": "my-agent-app",
  "type": "module",                 // REQUIRED — the SDK is ESM-only
  "dependencies": { "@skawld/agent-sdk": "^0.1.0" },
  "scripts": {
    "start": "bun run src/index.ts",      // Bun runs .ts directly
    "build": "tsc -p tsconfig.json"
  }
}
```

## tsconfig.json

Either `NodeNext` (Node) or `Bundler` (Bun/bundlers) module resolution works; the published types resolve cleanly under both.

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",   // or "Bundler"
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

Under `NodeNext`, **relative imports in your own code need explicit `.js` extensions** (`import { x } from "./util.js"`). Imports from `@skawld/agent-sdk` and its subpaths do not — they resolve through the package `exports` map.

## Import surface

Only these four subpaths are public. Never import from `@skawld/agent-sdk/dist/...`.

```ts
import { Agent, Session } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools, ToolRegistry } from "@skawld/agent-sdk/tools";
import { InMemorySessionStore, SqliteSessionStore } from "@skawld/agent-sdk/sessions";
import type { CanUseTool } from "@skawld/agent-sdk/permissions";
```

## Environment variables

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `AnthropicProvider` (falls back to the Anthropic SDK's default lookup) |
| `OPENAI_API_KEY` | `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider` |

Providers read these when constructed with no explicit `apiKey`. You can also pass `apiKey` directly to the provider constructor.

## On-disk layout the SDK reads

Resolved against `cwd`; the config root defaults to `.skawld` (override with `AgentOptions.configDir`, which also accepts a `string[]` to load from several config roots, first-dir-wins).

```
your-app/
├── package.json
├── tsconfig.json
├── src/index.ts
└── .skawld/                 # configDir (default)
    ├── sessions.db          # SqliteSessionStore (auto-created on first session)
    ├── skills/              # optional — auto-loaded skills
    │   └── <name>/SKILL.md
    └── agents/              # optional — auto-loaded subagents
        └── <name>.md
```

Skills and subagents are picked up automatically on the first `agent.session()` call. See `building-agents.md` for their file formats. Add `.skawld/sessions.db` to `.gitignore`.

## Minimal runnable entrypoint

```ts
// src/index.ts
import { Agent } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";

const agent = new Agent({
  provider: new AnthropicProvider(),
  model: "claude-opus-4-5",
  tools: defaultTools(),
});

const session = await agent.session();
for await (const e of session.run(process.argv.slice(2).join(" ") || "Hello!")) {
  if (e.type === "assistant")
    for (const b of e.message.content) if (b.type === "text") process.stdout.write(b.text);
  if (e.type === "result") break;
}
await agent.close();
```

Run: `bun run src/index.ts "list files here"`.

A fuller copy-paste scaffold (multi-turn REPL with permissions + persistence) lives in this skill's `assets/starter-app/`.
