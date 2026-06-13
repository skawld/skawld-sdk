---
name: skawld-sdk-dev
description: Build and run AI agents with the Skawld Agent SDK (@skawld/agent-sdk), a TypeScript/Bun agent harness with tools, sessions, permissions, hooks, streaming events, MCP, skills, and subagents. Use this skill whenever the user is writing code against @skawld/agent-sdk, importing Agent/Session/AnthropicProvider/OpenAIResponsesProvider/defaultTools, embedding an agent loop into a Node or Bun app, wiring custom tools, permission callbacks, hooks (preToolUse/postToolUse/userPromptSubmit/stop/preCompact), the AskUser tool, MCP servers, skills, or subagents, streaming agent events, steering or interrupting a run mid-flight, persisting/resuming sessions, or asks "how do I build an agent with skawld".
---

# Skawld Agent SDK Development

## Overview

The Skawld Agent SDK (`@skawld/agent-sdk`) is an open-source TypeScript agent harness for software-engineering tasks — a Claude Code-style agent loop you embed into any Node.js 18+ or Bun 1.1+ app with a single import. This skill teaches how to **use** the SDK (run an agent, stream events, persist sessions) and how to **build with** it (custom tools, permission callbacks, MCP servers, skills, subagents).

It is ESM-only. The core engine makes **zero I/O assumptions** — no console output, no terminal escapes inside the engine. The embedding app owns all I/O by consuming the event stream.

**Scope:** This skill handles building/using agents with `@skawld/agent-sdk` (the Skawld harness). It does **NOT** cover the Anthropic Claude API directly (use `claude-api`), the Claude Agent SDK from Anthropic (different package), generic MCP-server authoring (use `mcp-builder`), or non-skawld agent frameworks.

## When to use

Trigger this skill when the user:
- Imports from `@skawld/agent-sdk`, `@skawld/agent-sdk/providers`, `/tools`, `/sessions`, or `/permissions`.
- Constructs `new Agent({...})`, calls `agent.session()`, or iterates `session.run(prompt)`.
- Wires providers (`AnthropicProvider`, `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider`).
- Builds custom tools, a `canUseTool` permission callback, permission rules, MCP servers, skills, or subagents.
- Streams agent events, persists/resumes sessions, handles compaction, or handles SDK errors.

## Package map

Import only from these four public subpaths (controlled via the `exports` map):

| Subpath | Exports |
|---|---|
| `@skawld/agent-sdk` | `Agent`, `Session`, `defaultTools`, `connectMcpServers`, core types, `Event` types + `isSubagentEvent`/`isHookErrorEvent`, `Hooks` types, `AskUserHandler` types, error classes, `CompactionStrategy` |
| `@skawld/agent-sdk/providers` | `AnthropicProvider`, `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider`, `BaseProvider` |
| `@skawld/agent-sdk/tools` | `ToolRegistry`, `defaultTools`, built-in tool classes, MCP tool helpers, task types |
| `@skawld/agent-sdk/sessions` | `SqliteSessionStore`, `InMemorySessionStore`, `SessionStore` + task persistence types |
| `@skawld/agent-sdk/permissions` | `PermissionEngine`, `CanUseTool` callback types, permission rule types |

## Official documentation

The canonical, always-current docs live at **https://skawld.com/docs**. The nav has three groups (mirrored here exactly). Link the user to the page that matches their question; each maps to a section in this skill's references, which carry the same `📖 Docs:` page links.

**Getting started**
- Introduction — https://skawld.com/docs
- Install — https://skawld.com/docs/install
- Quickstart — https://skawld.com/docs/quickstart

**Concepts**
- Overview (the five objects + the loop) — https://skawld.com/docs/concepts
- Agent *(class)* — https://skawld.com/docs/agent
- Sessions — https://skawld.com/docs/sessions
- Events — https://skawld.com/docs/events
- Providers — https://skawld.com/docs/providers
- Tools — https://skawld.com/docs/tools
- MCP — https://skawld.com/docs/mcp
- Permissions — https://skawld.com/docs/permissions
- Skills — https://skawld.com/docs/skills
- Subagents — https://skawld.com/docs/subagents
- Compaction — https://skawld.com/docs/compaction

**Reference**
- Errors — https://skawld.com/docs/errors
- Configuration (tuning `AgentOptions`) — https://skawld.com/docs/configuration
- Public API — https://skawld.com/docs/api-surface

Page order: Introduction → Install → Quickstart → Overview → Agent → Sessions → Events → Providers → Tools → MCP → Permissions → Skills → Subagents → Compaction → Errors → Configuration → Public API.

## Quick start

```ts
import { Agent } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";

const agent = new Agent({
  provider: new AnthropicProvider(),   // reads ANTHROPIC_API_KEY from env
  model: "claude-opus-4-5",            // REQUIRED — there is no default model
  tools: defaultTools(),               // optional; defaults to the 10 built-ins
  permissions: { mode: "default" },    // default | acceptEdits | yolo
});

const session = await agent.session();

for await (const event of session.run("List the files in the current directory.")) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (event.type === "result") break;       // run finished
  if (event.type === "error") { console.error(event.error.message); break; }
}

await agent.close();   // closes the session store + disconnects MCP servers
```

Install with `bun add @skawld/agent-sdk` (Bun recommended; npm/pnpm/yarn also work).

## Core mental model

1. **`Agent`** = long-lived config: provider, model, tools, permissions, session store, MCP servers. Construct once.
2. **`agent.session()`** = create or resume a conversation. On the FIRST call it lazily connects MCP servers, loads skills, loads subagents, and allocates the SQLite store. Pass `{ id }` to resume a persisted session.
3. **`session.run(prompt)`** = one user turn. Returns an `AsyncIterable<Event>`. The loop runs until the model stops calling tools, then emits a `result` event. Only one run can be active per session at a time (throws `ConfigError` otherwise).
4. **Events** are the only output channel — the engine never writes to a console. Consume them to render UI, log, or drive a CLI.
5. **`agent.close()`** releases resources. Always call it.

## Task-based guidance

| Task | Where to look |
|---|---|
| Set up a consumer project (package.json, tsconfig, ESM, env) | `references/project-setup.md` |
| Construct an Agent, all `AgentOptions` fields | `references/api-reference.md` → AgentOptions |
| Run a turn, `RunOptions` (images, thinking, effort, temperature) | `references/api-reference.md` → Session & RunOptions |
| Handle every event type in the stream | `references/api-reference.md` → Event union |
| Pick/configure a provider; OpenAI-compatible endpoints (Ollama/vLLM/Groq) | `references/api-reference.md` → Providers |
| Built-in tools: exact params & scope; Task tools | `references/tools-catalog.md` |
| Data shapes (`Message`, `ContentBlock`, `Usage`, `StopReason`) | `references/api-reference.md` → Common types |
| Permissions: modes, rules, `canUseTool` callback | `references/building-agents.md` → Permissions |
| Hooks: `preToolUse`/`postToolUse`/`userPromptSubmit`/`stop`/`preCompact` | `references/building-agents.md` → Hooks |
| Ask the user mid-run (`AskUser` tool + handler) | `references/building-agents.md` → AskUser |
| Steer / interrupt an active run | `references/api-reference.md` → Session; `references/recipes.md` #12 |
| Persist & resume sessions; custom `SessionStore` | `references/building-agents.md` → Sessions; `api-reference.md` → SessionStore |
| Write a custom `Tool` | `references/building-agents.md` → Custom tools |
| Connect MCP servers (stdio + HTTP) | `references/building-agents.md` → MCP |
| Add skills (`.skawld/skills/<name>/SKILL.md`) | `references/building-agents.md` → Skills |
| Add subagents (`.skawld/agents/<name>.md`) | `references/building-agents.md` → Subagents |
| Custom provider (extend `BaseProvider`) or custom compaction | `references/building-agents.md` → Custom providers / compaction |
| Errors, retries, compaction, aborting a run | `references/api-reference.md` → Errors & lifecycle |
| Copy-paste patterns + test an agent app offline | `references/recipes.md` |
| Runnable starter app to copy & adapt | `assets/starter-app/` |

## Critical rules (do not violate)

- **Always provide `model`** — the SDK has no default model. Use a real model id for the chosen provider (e.g. `"claude-opus-4-5"` for Anthropic, `"gpt-5"` for OpenAI).
- **Always `await agent.close()`** when done, or the SQLite store / MCP child processes leak.
- **Import only from the four public subpaths.** Never reach into `dist/` internals or `src/`.
- **The engine is I/O-free.** Render output by consuming events, not by expecting the SDK to print.
- **One active run per session.** Calling `run()` again before the previous iterator finishes throws `ConfigError`. Use a second session for concurrency.
- **Read-before-Edit is enforced** by the `Edit` tool — the model must `Read` a file before `Edit` succeeds on it.
- **Permission `mode` defaults to `"default"`** (write/exec tools require approval via `canUseTool` or rules). `acceptEdits` auto-allows writes; `yolo` auto-allows everything. Read-scoped and Task tools are always allowed.

## References

- `references/project-setup.md` — consumer `package.json`/`tsconfig`/ESM, install, env vars, on-disk layout.
- `references/api-reference.md` — exact signatures: `AgentOptions` (incl. `hooks`/`askUser`), `RunOptions`, `Session` (incl. `steer`/`interrupt`), the `Event` union, provider constructors + OpenAI-compatible endpoints, data shapes, `SessionStore`, errors, lifecycle.
- `references/tools-catalog.md` — built-in tool params/scope, the Task tools and persistent task model, plus the conditionally-registered `AskUser`/`Skill`/`Subagent` tools.
- `references/building-agents.md` — extending the SDK: permissions, hooks, AskUser, sessions/stores, custom tools, MCP, skills, subagents, custom providers, custom compaction.
- `references/recipes.md` — copy-paste patterns: streaming UI, permission callback, rules, resume, abort, steer/interrupt, hooks + AskUser, images/thinking, MCP, REPL, offline testing.
- `assets/starter-app/` — a complete runnable terminal-agent scaffold (package.json + tsconfig + src) to copy and adapt.

When a detail is not covered here, the authoritative sources are the published docs at **https://skawld.com/docs** (see the per-concept link table above), the SDK's own `spec_docs/` (numbered `00-` through `12-`), and `src/sdk.ts` (the curated public export surface). Note: the config-file *loader* (`src/config/`) is a stub in v1 — configure agents in code via `AgentOptions` (the docs' Configuration page covers those knobs).
