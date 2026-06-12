/** Unit tests for the HookRunner (Phase 2 — hooks). */

import { describe, expect, it } from "bun:test";
import { HookRunner, type HookContext } from "./hooks.js";
import { ConfigError } from "./errors.js";
import type { Tool } from "../tools/base.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name = "Bash", validate?: (raw: Record<string, unknown>) => Record<string, unknown>): Tool<any> {
  return {
    name,
    description: "test tool",
    scope: "exec",
    parallelSafe: false,
    input_schema: { type: "object", properties: {}, required: [] },
    validate: validate ?? ((raw) => raw),
    async execute() { return { content: "", summary: "" }; },
    summarize: (input) => `${name}(${JSON.stringify(input)})`,
  };
}

function ctx(): HookContext {
  return { session_id: "s", run_id: "r", cwd: "/", signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// matcher glob
// ---------------------------------------------------------------------------

describe("HookRunner — matcher glob", () => {
  it("matches exact names, prefix globs, mcp globs, and '*'; case-sensitive; omitted matches all", async () => {
    const seen: string[] = [];
    const mk = (label: string) => () => { seen.push(label); return undefined; };
    const runner = new HookRunner({
      preToolUse: [
        { matcher: "Bash", hook: mk("exact") },
        { matcher: "Ba*", hook: mk("prefix") },
        { matcher: "mcp__github__*", hook: mk("mcp") },
        { matcher: "*", hook: mk("star") },
        { matcher: "bash", hook: mk("lowercase") }, // case-sensitive → no match
        { hook: mk("omitted") },
      ],
    });

    await runner.runPreToolUse({ tool: makeTool("Bash"), toolUseId: "t", input: {}, summary: "s", ctx: ctx() });
    expect(seen).toEqual(["exact", "prefix", "star", "omitted"]);

    seen.length = 0;
    await runner.runPreToolUse({
      tool: makeTool("mcp__github__create_issue"), toolUseId: "t", input: {}, summary: "s", ctx: ctx(),
    });
    expect(seen).toEqual(["mcp", "star", "omitted"]);
  });
});

// ---------------------------------------------------------------------------
// PreToolUse resolution
// ---------------------------------------------------------------------------

describe("HookRunner — PreToolUse resolution", () => {
  it("runs in registration order and resolves continue when no opinion", async () => {
    const order: number[] = [];
    const runner = new HookRunner({
      preToolUse: [
        { hook: () => { order.push(1); } },
        { hook: () => { order.push(2); } },
      ],
    });
    const res = await runner.runPreToolUse({ tool: makeTool(), toolUseId: "t", input: { a: 1 }, summary: "s", ctx: ctx() });
    expect(order).toEqual([1, 2]);
    expect(res.kind).toBe("continue");
    expect(res.errors).toHaveLength(0);
  });

  it("precedence deny > ask > allow > continue", async () => {
    const runner = new HookRunner({
      preToolUse: [
        { hook: () => ({ action: "allow" as const }) },
        { hook: () => ({ action: "ask" as const }) },
      ],
    });
    const res = await runner.runPreToolUse({ tool: makeTool(), toolUseId: "t", input: {}, summary: "s", ctx: ctx() });
    expect(res.kind).toBe("ask");
  });

  it("deny short-circuits remaining hooks", async () => {
    let secondRan = false;
    const runner = new HookRunner({
      preToolUse: [
        { hook: () => ({ action: "deny" as const, reason: "nope" }) },
        { hook: () => { secondRan = true; } },
      ],
    });
    const res = await runner.runPreToolUse({ tool: makeTool(), toolUseId: "t", input: {}, summary: "s", ctx: ctx() });
    expect(res.kind).toBe("deny");
    expect(res.reason).toBe("nope");
    expect(secondRan).toBe(false);
  });

  it("threads updatedInput through later hooks and re-validates / re-summarizes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const runner = new HookRunner({
      preToolUse: [
        { hook: (input) => { seen.push(input.input); return { action: "continue" as const, updatedInput: { path: "/staged" } }; } },
        { hook: (input) => { seen.push(input.input); return undefined; } },
      ],
    });
    const res = await runner.runPreToolUse({ tool: makeTool("Write"), toolUseId: "t", input: { path: "/orig" }, summary: "s", ctx: ctx() });
    expect(seen[0]).toEqual({ path: "/orig" });
    expect(seen[1]).toEqual({ path: "/staged" });
    expect(res.input).toEqual({ path: "/staged" });
    expect(res.summary).toBe('Write({"path":"/staged"})');
  });

  it("invalid rewrite (validate throws) converts the resolution to deny", async () => {
    const tool = makeTool("Write", (raw) => { if (raw.bad) throw new Error("bad shape"); return raw; });
    const runner = new HookRunner({
      preToolUse: [{ hook: () => ({ action: "continue" as const, updatedInput: { bad: true } }) }],
    });
    const res = await runner.runPreToolUse({ tool, toolUseId: "t", input: {}, summary: "s", ctx: ctx() });
    expect(res.kind).toBe("deny");
    expect(res.reason).toContain("invalid hook rewrite");
    expect(res.reason).toContain("bad shape");
  });

  it("fails CLOSED on throw — deny + HookErrorEvent", async () => {
    const runner = new HookRunner({
      preToolUse: [{ hook: () => { throw new Error("boom"); } }],
    });
    const res = await runner.runPreToolUse({ tool: makeTool(), toolUseId: "tu-9", input: {}, summary: "s", ctx: ctx() });
    expect(res.kind).toBe("deny");
    expect(res.reason).toBe("Hook failed: boom");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ type: "hook_error", hook_event: "PreToolUse", message: "boom", tool_use_id: "tu-9" });
  });

  it("fails CLOSED on timeout with the standard message", async () => {
    const runner = new HookRunner({
      preToolUse: [{ timeoutMs: 20, hook: () => new Promise<never>(() => {}) }],
    });
    const res = await runner.runPreToolUse({ tool: makeTool(), toolUseId: "t", input: {}, summary: "s", ctx: ctx() });
    expect(res.kind).toBe("deny");
    expect(res.errors[0]!.message).toBe("Hook timed out after 20ms");
  });
});

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

describe("HookRunner — PostToolUse", () => {
  it("collects additionalContext in registration order; ignores empty/void", async () => {
    const runner = new HookRunner({
      postToolUse: [
        { hook: () => ({ additionalContext: "first" }) },
        { hook: () => undefined },
        { hook: () => ({ additionalContext: "" }) },
        { hook: () => ({ additionalContext: "second" }) },
      ],
    });
    const res = await runner.runPostToolUse({
      tool: makeTool(), toolUseId: "t", input: {}, content: "out", isError: false, durationMs: 5, ctx: ctx(),
    });
    expect(res.additionalContext).toEqual(["first", "second"]);
  });

  it("fails OPEN on throw — HookErrorEvent, no additionalContext from that hook", async () => {
    const runner = new HookRunner({
      postToolUse: [
        { hook: () => { throw new Error("post boom"); } },
        { hook: () => ({ additionalContext: "survives" }) },
      ],
    });
    const res = await runner.runPostToolUse({
      tool: makeTool(), toolUseId: "tu-2", input: {}, content: "out", isError: false, durationMs: 5, ctx: ctx(),
    });
    expect(res.additionalContext).toEqual(["survives"]);
    expect(res.errors[0]).toMatchObject({ hook_event: "PostToolUse", message: "post boom", tool_use_id: "tu-2" });
  });
});

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

describe("HookRunner — UserPromptSubmit", () => {
  it("first block short-circuits", async () => {
    let secondRan = false;
    const runner = new HookRunner({
      userPromptSubmit: [
        { hook: () => ({ action: "block" as const, reason: "has secret" }) },
        { hook: () => { secondRan = true; } },
      ],
    });
    const res = await runner.runUserPromptSubmit({ prompt: "p", source: "run", ctx: ctx() });
    expect(res.blocked?.reason).toBe("has secret");
    expect(secondRan).toBe(false);
  });

  it("accumulates additionalContext and fails open on throw", async () => {
    const runner = new HookRunner({
      userPromptSubmit: [
        { hook: () => ({ action: "continue" as const, additionalContext: "ctx-a" }) },
        { hook: () => { throw new Error("ups boom"); } },
        { hook: () => ({ action: "continue" as const, additionalContext: "ctx-b" }) },
      ],
    });
    const res = await runner.runUserPromptSubmit({ prompt: "p", source: "run", ctx: ctx() });
    expect(res.blocked).toBeUndefined();
    expect(res.additionalContext).toEqual(["ctx-a", "ctx-b"]);
    expect(res.errors[0]).toMatchObject({ hook_event: "UserPromptSubmit", message: "ups boom" });
    expect(res.errors[0]!.tool_use_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("HookRunner — Stop", () => {
  it("first block wins; fail open on throw", async () => {
    const runner = new HookRunner({
      stop: [
        { hook: () => { throw new Error("stop boom"); } },
        { hook: (input) => (input.stop_hook_active ? undefined : { action: "block" as const, reason: "not done" }) },
      ],
    });
    const res = await runner.runStop({ stopReason: "end_turn", stopHookActive: false, ctx: ctx() });
    expect(res.blocked?.reason).toBe("not done");
    expect(res.errors[0]).toMatchObject({ hook_event: "Stop", message: "stop boom" });
  });

  it("respects stop_hook_active to self-bound", async () => {
    const runner = new HookRunner({
      stop: [{ hook: (input) => (input.stop_hook_active ? undefined : { action: "block" as const, reason: "again" }) }],
    });
    const res = await runner.runStop({ stopReason: "end_turn", stopHookActive: true, ctx: ctx() });
    expect(res.blocked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PreCompact
// ---------------------------------------------------------------------------

describe("HookRunner — PreCompact", () => {
  it("runs observationally and fails open on throw", async () => {
    const seen: Array<{ trigger: string; messages_before: number; tokens_before: number }> = [];
    const runner = new HookRunner({
      preCompact: [
        { hook: (input) => { seen.push(input); } },
        { hook: () => { throw new Error("pc boom"); } },
      ],
    });
    const res = await runner.runPreCompact({ trigger: "threshold", messagesBefore: 30, tokensBefore: 1000, ctx: ctx() });
    expect(seen[0]).toEqual({ trigger: "threshold", messages_before: 30, tokens_before: 1000 });
    expect(res.errors[0]).toMatchObject({ hook_event: "PreCompact", message: "pc boom" });
  });
});

// ---------------------------------------------------------------------------
// Construction validation
// ---------------------------------------------------------------------------

describe("HookRunner — construction validation", () => {
  it("accepts an empty config and reports has* false", () => {
    const runner = new HookRunner({});
    expect(runner.hasPreToolUse).toBe(false);
    expect(runner.hasStop).toBe(false);
  });

  it("rejects a registration without a hook function", () => {
    expect(() => new HookRunner({ preToolUse: [{ matcher: "Bash" } as any] })).toThrow(ConfigError);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() => new HookRunner({ stop: [{ timeoutMs: 0, hook: () => undefined }] })).toThrow(ConfigError);
    expect(() => new HookRunner({ stop: [{ timeoutMs: -5, hook: () => undefined }] })).toThrow(ConfigError);
  });

  it("rejects a non-string matcher", () => {
    expect(() => new HookRunner({ preToolUse: [{ matcher: 123 as any, hook: () => undefined }] })).toThrow(ConfigError);
  });
});
