/** End-to-end tests for UserPromptSubmit + Stop hooks in the loop. */

import { describe, expect, it } from "bun:test";
import { Agent } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Event, UserEvent, HookErrorEvent } from "./events.js";
import type { Hooks } from "./hooks.js";

function makeAgent(provider: MockProvider, opts?: { hooks?: Hooks; maxTurns?: number }) {
  const store = new InMemorySessionStore();
  return new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    permissions: { mode: "yolo" },
    maxTurns: opts?.maxTurns ?? 100,
    hooks: opts?.hooks,
  });
}

async function collectEvents(iterable: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

function simpleTextScript(text = "hello") {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

const textBlocks = (ev: UserEvent): string[] =>
  ev.message.content.filter(b => b.type === "text").map(b => (b as { text: string }).text);

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

describe("runLoop — UserPromptSubmit additionalContext", () => {
  it("appends a system-reminder block after the prompt block", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("done"));
    const agent = makeAgent(provider, {
      hooks: { userPromptSubmit: [{ hook: () => ({ action: "continue", additionalContext: "ticket-42" }) }] },
    });
    const session = await agent.session();
    const events = await collectEvents(session.run("do the thing"));

    const userEv = events.find(e => e.type === "user") as UserEvent;
    const texts = textBlocks(userEv);
    const promptIdx = texts.findIndex(t => t === "do the thing");
    const ctxIdx = texts.findIndex(t => t.includes("<system-reminder>") && t.includes("ticket-42"));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(promptIdx);
  });
});

describe("runLoop — UserPromptSubmit block (source run)", () => {
  it("emits ErrorEvent(HookError) + result(error), no user event; session stays usable", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("second run ok"));
    let blockFirst = true;
    const agent = makeAgent(provider, {
      hooks: { userPromptSubmit: [{ hook: () => (blockFirst ? ({ action: "block", reason: "contains a secret" }) : undefined) }] },
    });
    const session = await agent.session();

    const first = await collectEvents(session.run("leak SECRET"));
    expect(first.some(e => e.type === "user")).toBe(false);
    const err = first.find(e => e.type === "error") as Extract<Event, { type: "error" }>;
    expect(err.error.name).toBe("HookError");
    expect(err.error.message).toContain("contains a secret");
    expect(err.error.retryable).toBe(false);
    const result = first.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("error");

    // The session remains usable for a subsequent run.
    blockFirst = false;
    const second = await collectEvents(session.run("normal prompt"));
    expect(second.some(e => e.type === "result" && e.subtype === "success")).toBe(true);
  });
});

describe("runLoop — UserPromptSubmit / Stop gated for subagent runs", () => {
  it("neither hook fires when toolsOverride is set (a subagent child run)", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("child"));
    let upsRan = false;
    let stopRan = false;
    const agent = makeAgent(provider, {
      hooks: {
        userPromptSubmit: [{ hook: () => { upsRan = true; } }],
        stop: [{ hook: () => { stopRan = true; } }],
      },
    });
    const session = await agent.session();
    // Simulate a subagent child: the runner sets a toolsOverride on the child.
    getSessionInternals(session).toolsOverride = new ToolRegistry();

    const events = await collectEvents(session.run("child prompt"));
    expect(upsRan).toBe(false);
    expect(stopRan).toBe(false);
    expect(events.some(e => e.type === "user" && e.subtype === "stop_hook")).toBe(false);
    expect(events.some(e => e.type === "result" && e.subtype === "success")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("runLoop — Stop block continuation", () => {
  it("blocks once then continues; appends a stop_hook user message", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("first"));
    provider.enqueue(simpleTextScript("second"));
    const agent = makeAgent(provider, {
      hooks: { stop: [{ hook: (input) => (input.stop_hook_active ? undefined : ({ action: "block", reason: "tests still red" })) }] },
    });
    const session = await agent.session();
    const events = await collectEvents(session.run("ship it"));

    const stopUser = events.find(e => e.type === "user" && e.subtype === "stop_hook") as UserEvent | undefined;
    expect(stopUser).toBeDefined();
    expect((stopUser!.message.content[0] as { text: string }).text).toBe(
      "<system-reminder>\ntests still red\n</system-reminder>",
    );
    expect(events.filter(e => e.type === "assistant")).toHaveLength(2);
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");
  });

  it("the continuation counts toward maxTurns", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("only"));
    const agent = makeAgent(provider, {
      maxTurns: 1,
      hooks: { stop: [{ hook: () => ({ action: "block", reason: "again" }) }] },
    });
    const session = await agent.session();
    const events = await collectEvents(session.run("x"));

    // turn 0 ran, Stop blocked, continue → turn 1 hits the cap → TurnLimitError.
    expect(events.some(e => e.type === "user" && e.subtype === "stop_hook")).toBe(true);
    const err = events.find(e => e.type === "error") as Extract<Event, { type: "error" }>;
    expect(err.error.name).toBe("TurnLimitError");
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("error");
  });

  it("fails open on throw: hook_error event + success result", async () => {
    const provider = new MockProvider();
    provider.enqueue(simpleTextScript("done"));
    const agent = makeAgent(provider, {
      hooks: { stop: [{ hook: () => { throw new Error("stop boom"); } }] },
    });
    const session = await agent.session();
    const events = await collectEvents(session.run("x"));

    const hookErr = events.find(e => e.type === "hook_error") as HookErrorEvent;
    expect(hookErr.hook_event).toBe("Stop");
    expect(hookErr.message).toBe("stop boom");
    const result = events.find(e => e.type === "result") as Extract<Event, { type: "result" }>;
    expect(result.subtype).toBe("success");
  });
});
