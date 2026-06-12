/** Tests for Session.steer() / Session.interrupt() — module 15. */

import { describe, expect, it } from "bun:test";
import { Agent } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import { MockWriteTool } from "./_test-mock-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { AbortError, ConfigError, HookError } from "./errors.js";
import type { Event, UserEvent, ResultEvent } from "./events.js";
import type { Hooks } from "./hooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(provider: MockProvider, opts?: { hooks?: Hooks; maxTurns?: number; tools?: ToolRegistry }) {
  const store = new InMemorySessionStore();
  return new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    permissions: { mode: "yolo" },
    maxTurns: opts?.maxTurns ?? 100,
    ...(opts?.hooks !== undefined && { hooks: opts.hooks }),
    ...(opts?.tools !== undefined && { tools: opts.tools }),
  });
}

function writeToolRegistry(): ToolRegistry {
  const write = new MockWriteTool("write-ok");
  Object.defineProperty(write, "name", { value: "MockWrite", writable: false });
  const tools = new ToolRegistry();
  tools.register(write);
  return tools;
}

function textTurn(text: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ],
  };
}

function toolUseTurn(id: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "tool_use_start" as const, id, name: "MockWrite" },
      { type: "tool_use_input_delta" as const, id, json_delta: "{}" },
      { type: "tool_use_end" as const, id },
      {
        type: "message_end" as const,
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ],
  };
}

async function collectEvents(iterable: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

/**
 * Drive a run step by step, firing each action once when its predicate first
 * matches a yielded event. Because the loop only advances when the consumer
 * pulls, an action that calls steer()/interrupt() takes effect at the next
 * drain point.
 */
async function driveWith(
  iterable: AsyncIterable<Event>,
  actions: Array<{ on: (ev: Event) => boolean; do: () => void }>,
): Promise<Event[]> {
  const events: Event[] = [];
  const iter = iterable[Symbol.asyncIterator]();
  const fired = actions.map(() => false);
  for (;;) {
    const { value, done } = await iter.next();
    if (done) break;
    events.push(value);
    actions.forEach((a, i) => {
      if (!fired[i] && a.on(value)) {
        fired[i] = true;
        a.do();
      }
    });
  }
  return events;
}

const userText = (ev: UserEvent): string[] =>
  ev.message.content.filter(b => b.type === "text").map(b => (b as { text: string }).text);

const lastResult = (events: Event[]): ResultEvent =>
  events.filter(e => e.type === "result").at(-1) as ResultEvent;

// ---------------------------------------------------------------------------
// steer() — active-run requirement
// ---------------------------------------------------------------------------

describe("Session.steer — idle requirement", () => {
  it("throws ConfigError synchronously when no run is active", async () => {
    const provider = new MockProvider();
    const agent = makeAgent(provider);
    const session = await agent.session();
    expect(() => session.steer("x")).toThrow(ConfigError);
    await agent.close();
  });
});

describe("Session.interrupt — idle no-op", () => {
  it("interrupt() while idle does not poison the next run", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider);
    const session = await agent.session();

    session.interrupt(); // idle — must be reset before the next run

    const events = await collectEvents(session.run("hi"));
    expect(lastResult(events).subtype).toBe("success");
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// steer() — injection
// ---------------------------------------------------------------------------

describe("Session.steer — mid-run injection", () => {
  it("injects a steering user message at the next turn boundary", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0")); // turn 0: tool_use
    provider.enqueue(textTurn("done"));      // turn 1: after steering drains
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => { steerP = session.steer("also do X"); },
      },
    ]);

    await expect(steerP!).resolves.toBeUndefined();

    const steering = events.filter(e => e.type === "user" && e.subtype === "steering") as UserEvent[];
    expect(steering).toHaveLength(1);
    expect(userText(steering[0]!)).toEqual(["also do X"]);

    // The steering message lands before the second assistant turn.
    const steeringIdx = events.findIndex(e => e.type === "user" && e.subtype === "steering");
    const assistantIdxs = events.flatMap((e, i) => (e.type === "assistant" ? [i] : []));
    expect(steeringIdx).toBeGreaterThan(assistantIdxs[0]!);
    expect(steeringIdx).toBeLessThan(assistantIdxs[1]!);

    expect(lastResult(events).subtype).toBe("success");
    await agent.close();
  });

  it("carries no env prefix or skill listing — plain prompt content only", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => { steerP = session.steer("plain message"); },
      },
    ]);
    await steerP;

    const steering = events.find(e => e.type === "user" && e.subtype === "steering") as UserEvent;
    // Exactly one text block, equal to the prompt — no env prefix block.
    expect(steering.message.content).toHaveLength(1);
    expect(userText(steering)).toEqual(["plain message"]);
    await agent.close();
  });
});

describe("Session.steer — stop-boundary injection", () => {
  it("a message queued when the model finished continues the run", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurn("first"));  // turn 0: end_turn
    provider.enqueue(textTurn("second")); // turn 1: after stop-boundary drain
    const agent = makeAgent(provider);
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      // Fire when turn 0's usage event lands — the stop boundary runs on the
      // next pull and sees the queued message.
      { on: (ev) => ev.type === "usage", do: () => { steerP = session.steer("keep going"); } },
    ]);

    await expect(steerP!).resolves.toBeUndefined();

    const steering = events.filter(e => e.type === "user" && e.subtype === "steering") as UserEvent[];
    expect(steering).toHaveLength(1);
    expect(userText(steering[0]!)).toEqual(["keep going"]);

    // Two assistant turns ran: the run continued past the first stop.
    expect(events.filter(e => e.type === "assistant")).toHaveLength(2);
    expect(lastResult(events).subtype).toBe("success");
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// interrupt()
// ---------------------------------------------------------------------------

describe("Session.interrupt — mid-run", () => {
  it("ends with subtype 'interrupted'; the in-flight turn persists", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0")); // turn 0 completes + persists
    provider.enqueue(textTurn("never"));   // turn 1: must never run
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    const events = await driveWith(session.run("hi"), [
      { on: (ev) => ev.type === "user" && ev.subtype === "tool_result", do: () => session.interrupt() },
    ]);

    expect(lastResult(events).subtype).toBe("interrupted");
    expect(lastResult(events).stop_reason).toBe("error");
    // The in-flight turn's assistant message + tool result are present.
    expect(events.some(e => e.type === "assistant")).toBe(true);
    expect(events.some(e => e.type === "user" && e.subtype === "tool_result")).toBe(true);
    // No second turn happened.
    expect(events.filter(e => e.type === "assistant")).toHaveLength(1);
    await agent.close();
  });
});

describe("Session.interrupt — at the stop boundary", () => {
  it("emits success when the model already finished (interrupt is moot)", async () => {
    const provider = new MockProvider();
    provider.enqueue(textTurn("all done"));
    const agent = makeAgent(provider);
    const session = await agent.session();

    const events = await driveWith(session.run("hi"), [
      { on: (ev) => ev.type === "usage", do: () => session.interrupt() },
    ]);

    const result = lastResult(events);
    expect(result.subtype).toBe("success");
    expect(result.final_text).toBe("all done");
    await agent.close();
  });
});

describe("Session.interrupt — precedence over steering", () => {
  it("interrupt wins at top-of-turn: steers reject with AbortError, run interrupts", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("never"));
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => {
          steerP = session.steer("dropped");
          session.interrupt();
        },
      },
    ]);

    expect(lastResult(events).subtype).toBe("interrupted");
    // Nothing injected.
    expect(events.some(e => e.type === "user" && e.subtype === "steering")).toBe(false);
    await expect(steerP!).rejects.toBeInstanceOf(AbortError);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Run-end rejection
// ---------------------------------------------------------------------------

describe("Session.steer — rejection on run end", () => {
  it("a message still queued when maxTurns is hit rejects with AbortError", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0")); // turn 0 (only turn allowed)
    const agent = makeAgent(provider, { tools: writeToolRegistry(), maxTurns: 1 });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => { steerP = session.steer("too late"); },
      },
    ]);

    // The turn cap is hit before turn 1's drain point.
    const err = events.find(e => e.type === "error") as Extract<Event, { type: "error" }>;
    expect(err.error.name).toBe("TurnLimitError");
    expect(lastResult(events).subtype).toBe("error");
    await expect(steerP!).rejects.toBeInstanceOf(AbortError);
    await agent.close();
  });

  it("a queued message rejects with AbortError when the run is aborted", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => {
          steerP = session.steer("queued");
          session.abort();
        },
      },
    ]);

    expect(lastResult(events).subtype).toBe("aborted");
    await expect(steerP!).rejects.toBeInstanceOf(AbortError);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// UserPromptSubmit interplay (source: "steer")
// ---------------------------------------------------------------------------

describe("Session.steer — UserPromptSubmit block", () => {
  it("blocks only the offending message; later messages still inject", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider, {
      tools: writeToolRegistry(),
      hooks: {
        userPromptSubmit: [
          { hook: (input) => (input.prompt.includes("secret") ? { action: "block", reason: "contains a secret" } : undefined) },
        ],
      },
    });
    const session = await agent.session();

    let blockedP: Promise<void> | undefined;
    let okP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => {
          blockedP = session.steer("a secret value");
          okP = session.steer("a fine value");
        },
      },
    ]);

    await expect(blockedP!).rejects.toBeInstanceOf(HookError);
    await expect(okP!).resolves.toBeUndefined();

    const steering = events.filter(e => e.type === "user" && e.subtype === "steering") as UserEvent[];
    expect(steering).toHaveLength(1);
    expect(userText(steering[0]!)).toEqual(["a fine value"]);

    // A blocked steer emits no ErrorEvent.
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(lastResult(events).subtype).toBe("success");
    await agent.close();
  });

  it("attaches additionalContext to the steering message", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider, {
      tools: writeToolRegistry(),
      hooks: {
        userPromptSubmit: [
          { hook: (input) => (input.source === "steer" ? { action: "continue", additionalContext: "ctx-99" } : undefined) },
        ],
      },
    });
    const session = await agent.session();

    let steerP: Promise<void> | undefined;
    const events = await driveWith(session.run("hi"), [
      {
        on: (ev) => ev.type === "user" && ev.subtype === "tool_result",
        do: () => { steerP = session.steer("with context"); },
      },
    ]);
    await steerP;

    const steering = events.find(e => e.type === "user" && e.subtype === "steering") as UserEvent;
    const texts = userText(steering);
    expect(texts[0]).toBe("with context");
    expect(texts.some(t => t.includes("ctx-99"))).toBe(true);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// Event subtypes at every emission site
// ---------------------------------------------------------------------------

describe("UserEvent.subtype — emission sites", () => {
  it("sets 'prompt' on the opening message and 'tool_result' on tool results", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-0"));
    provider.enqueue(textTurn("done"));
    const agent = makeAgent(provider, { tools: writeToolRegistry() });
    const session = await agent.session();

    const events = await collectEvents(session.run("hi"));
    const users = events.filter(e => e.type === "user") as UserEvent[];

    expect(users[0]!.subtype).toBe("prompt");
    expect(users.some(u => u.subtype === "tool_result")).toBe(true);
    await agent.close();
  });
});
