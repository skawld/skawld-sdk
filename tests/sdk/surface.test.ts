/**
 * SDK surface smoke tests — fast source layer.
 *
 * Imports the public barrels via relative source paths (no build required) and
 * exercises the spec's documented scenarios end-to-end with the in-repo mock
 * provider + InMemorySessionStore. The goal is to prove the public export NAMES
 * exist and are usable together — not to re-test engine internals (those have
 * dedicated module tests).
 *
 * A bunfig `skawld → src` alias is deliberately NOT used: it would also shadow
 * the package self-reference in dist-smoke.test.ts and silently defeat that
 * test. Relative imports give the same coverage with no aliasing footgun.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, defaultTools, SkawldError, AuthError, HookError, isHookErrorEvent, loadConfig } from "../../src/sdk.js";
import type { LoadedConfig, SkawldConfig, ConfigWarning, Hooks, PreToolUseHook, StopHook, HookErrorEvent } from "../../src/sdk.js";
import { InMemorySessionStore } from "../../src/sessions/index.js";
import { ToolRegistry } from "../../src/tools/index.js";
import type { CanUseTool } from "../../src/permissions/index.js";
import type { Event } from "../../src/core/events.js";
import { MockProvider } from "../../src/core/_test-mock-provider.js";
import { MockWriteTool } from "../../src/core/_test-mock-tools.js";

async function collect(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function textTurn(text = "hi") {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

function toolUseTurn(id: string, name: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "tool_use_start" as const, id, name },
      { type: "tool_use_input_delta" as const, id, json_delta: "{}" },
      { type: "tool_use_end" as const, id },
      {
        type: "message_end" as const,
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

describe("SDK surface — fast source layer", () => {
  test("minimal usage: Agent + defaultTools from main entry → result event", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurn("hello world"));
    const agent = new Agent({
      provider,
      model: "test-model",
      tools: defaultTools(),
      sessionStore: new InMemorySessionStore(),
      permissions: { mode: "yolo" },
    });

    const session = await agent.session();
    const events = await collect(session.run("write a hello world script"));

    expect(events.at(-1)!.type).toBe("result");
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");

    await agent.close();
  });

  test("custom session store: resume by id preserves messages", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    provider.enqueue(textTurn("explained"));
    const agent = new Agent({
      provider,
      model: "test-model",
      tools: defaultTools(),
      sessionStore: store,
      permissions: { mode: "yolo" },
    });

    const a = await agent.session({ meta: { title: "parser refactor" } });
    await collect(a.run("explain the parser"));

    const b = await agent.session({ id: a.id });
    expect(b.id).toBe(a.id);
    expect(b.messageCount).toBeGreaterThan(0);

    await agent.close();
  });

  test("custom canUseTool: deny blocks the tool call", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-1", "MockWrite"));
    provider.enqueue(textTurn("done"));

    const tools = new ToolRegistry();
    tools.register(new MockWriteTool("should not run"));

    const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: "blocked by smoke test" });

    const agent = new Agent({
      provider,
      model: "test-model",
      tools,
      sessionStore: new InMemorySessionStore(),
      permissions: { mode: "default", canUseTool },
    });

    const session = await agent.session();
    const events = await collect(session.run("write it"));

    expect(events.some(e => e.type === "permission_request")).toBe(true);
    const end = events.find(e => e.type === "tool_call_end") as Extract<Event, { type: "tool_call_end" }>;
    expect(end.is_error).toBe(true);

    await agent.close();
  });

  test("abort: aborting the run signal yields result(aborted)", async () => {
    const provider = new MockProvider();
    const deferred = provider.enqueue({ ...textTurn("partial"), holdAt: 1 });

    const agent = new Agent({
      provider,
      model: "test-model",
      tools: defaultTools(),
      sessionStore: new InMemorySessionStore(),
      permissions: { mode: "yolo" },
    });

    const session = await agent.session();
    const controller = new AbortController();
    const eventsPromise = collect(session.run("refactor the parser", { signal: controller.signal }));

    await new Promise(r => setTimeout(r, 20));
    controller.abort(new Error("timeout"));
    deferred.resolve();

    const events = await eventsPromise;
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }> | undefined;
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("aborted");

    await agent.close();
  });

  test("errors: typed error classes extend SkawldError", () => {
    expect(new AuthError("x")).toBeInstanceOf(SkawldError);
    expect(new HookError("x")).toBeInstanceOf(SkawldError);
  });

  test("hooks: AgentOptions.hooks public types + a Stop block continues the loop", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurn("first"));
    provider.enqueue(textTurn("second"));

    // Public hook types are usable from the main entry.
    const preTool: PreToolUseHook = () => undefined;
    const stop: StopHook = (input) => (input.stop_hook_active ? undefined : { action: "block", reason: "keep going" });
    const hooks: Hooks = { preToolUse: [{ matcher: "*", hook: preTool }], stop: [{ hook: stop }] };

    const agent = new Agent({
      provider,
      model: "test-model",
      tools: defaultTools(),
      sessionStore: new InMemorySessionStore(),
      permissions: { mode: "yolo" },
      hooks,
    });

    const session = await agent.session();
    const events = await collect(session.run("ship it"));

    expect(events.some(e => e.type === "user" && e.subtype === "stop_hook")).toBe(true);
    expect(events.filter(e => e.type === "assistant")).toHaveLength(2);
    // HookErrorEvent guard + type are exported.
    const hookErrors: HookErrorEvent[] = events.filter(isHookErrorEvent);
    expect(Array.isArray(hookErrors)).toBe(true);

    await agent.close();
  });

  test("config: loadConfig from main entry merges a project file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skawld-surface-cfg-"));
    try {
      const skawldDir = path.join(root, ".skawld");
      mkdirSync(skawldDir, { recursive: true });
      const cfg: SkawldConfig = { model: "claude-sonnet-4-6", provider: { id: "anthropic" } };
      writeFileSync(path.join(skawldDir, "config.json"), JSON.stringify(cfg));

      const loaded: LoadedConfig = await loadConfig({ cwd: root, env: { HOME: root } });
      expect(loaded.config.model).toBe("claude-sonnet-4-6");
      const warnings: ConfigWarning[] = loaded.warnings;
      expect(Array.isArray(warnings)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
