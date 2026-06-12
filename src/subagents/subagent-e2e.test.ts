/**
 * End-to-end subagent tests.
 *
 * Each test exercises one of the 10 success criteria from
 * `plans/260525-2150-subagent-module/brainstorm-summary.md` through the full
 * Agent → Session → runLoop → Subagent tool → runner → child Session stack.
 * Uses MockProvider for deterministic, fast iteration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../core/agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "../core/_test-mock-provider.js";
import { ReadTool } from "../tools/read.js";
import { GrepTool } from "../tools/grep.js";
import { BashTool } from "../tools/bash.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ProviderRequest, ProviderStreamEvent } from "../providers/base.js";
import type { Event, SubagentEvent } from "../core/events.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let configDir: string;
let agentsDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "skawld-subagent-e2e-"));
  agentsDir = path.join(configDir, "agents");
  await mkdir(agentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function writeAgent(file: string, content: string): Promise<void> {
  await writeFile(path.join(agentsDir, file), content);
}

/** Turn that produces a single assistant text message (no tool use). */
function textTurn(text: string): { events: ProviderStreamEvent[] } {
  return {
    events: [
      { type: "message_start", model: "test-model" },
      { type: "text_delta", text },
      {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

/**
 * Turn that emits an assistant message calling exactly one tool with the given
 * input. Pairs with a follow-up `textTurn` for the final text after the tool
 * result returns.
 */
function toolCallTurn(opts: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}): { events: ProviderStreamEvent[] } {
  const json = JSON.stringify(opts.input);
  return {
    events: [
      { type: "message_start", model: "test-model" },
      { type: "tool_use_start", id: opts.toolUseId, name: opts.toolName },
      { type: "tool_use_input_delta", id: opts.toolUseId, json_delta: json },
      { type: "tool_use_end", id: opts.toolUseId },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

interface E2ERig {
  agent: Agent;
  provider: MockProvider;
  capturedRequests: ProviderRequest[];
  store: InMemorySessionStore;
}

async function makeRig(opts?: { tools?: ToolRegistry; hooks?: import("../core/hooks.js").Hooks }): Promise<E2ERig> {
  const store = new InMemorySessionStore();
  const provider = new MockProvider();
  const capturedRequests: ProviderRequest[] = [];
  const origStream = provider.stream.bind(provider);
  provider.stream = (req: ProviderRequest) => {
    capturedRequests.push(req);
    return origStream(req);
  };

  const agent = new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    configDir,
    tools: opts?.tools,
    permissions: { mode: "yolo" },
    hooks: opts?.hooks,
  });
  return { agent, provider, capturedRequests, store };
}

async function collectEvents(
  iter: AsyncIterable<Event>,
): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

describe("subagent e2e — acceptance criteria from brainstorm summary", () => {
  it("SC#1: default Subagent({description, prompt}) — full non-Subagent tools; Agent #1", async () => {
    const rig = await makeRig();
    // Parent: 1 turn that calls Subagent, then 1 turn that yields final text.
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-1",
        toolName: "Subagent",
        input: { description: "go", prompt: "do work" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    // Child: 1 turn that produces text.
    rig.provider.enqueue(textTurn("Child output here."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // Child's events arrive wrapped — first SubagentEvent's display name == Agent #1.
    const subEvents = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents[0]!.display_name).toBe("Agent #1");
    expect(subEvents[0]!.subagent_type).toBe("_default");

    // Parent saw a tool_call_end for the Subagent tool with the child's text.
    const userMsg = events.find(
      (e) =>
        e.type === "user" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === "tu-1",
        ),
    );
    expect(userMsg).toBeDefined();
  });

  it("SC#2: named subagent — resolves <configDir>/agents/researcher.md, uses body as system prompt", async () => {
    await writeAgent(
      "researcher.md",
      "---\ndescription: Researches things.\n---\nYou are a thorough researcher.\n",
    );
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-r",
        toolName: "Subagent",
        input: { description: "research", prompt: "x", subagent_type: "researcher" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Research output."));

    const session = await rig.agent.session();
    await collectEvents(session.run("start"));

    // The child's provider request carries the agent body as its
    // user-instructions block. Find it by content (request order is parent#1,
    // child, parent#2 — index 1 — but assert by content for robustness).
    const childReq = rig.capturedRequests.find((req) =>
      (req.system as Array<{ type: string; text: string }>).some(
        (b) => b.type === "text" && b.text.includes("You are a thorough researcher."),
      ),
    );
    expect(childReq).toBeDefined();
    const userInstr = (childReq!.system as Array<{ type: string; text: string }>).find(
      (b) => b.type === "text" && b.text.includes("User-provided instructions"),
    );
    expect(userInstr).toBeDefined();
    expect(userInstr!.text).toContain("You are a thorough researcher.");
  });

  it("SC#3: tools allowlist narrows child registry to exactly the named tools (no auto-Subagent)", async () => {
    await writeAgent(
      "narrow.md",
      "---\ndescription: Narrow tools.\ntools: [Read, Grep]\n---\nBody.\n",
    );
    // Give the parent Read + Grep + Bash so the filter actually narrows.
    const parentTools = new ToolRegistry();
    parentTools.register(new ReadTool());
    parentTools.register(new GrepTool());
    parentTools.register(new BashTool());
    const rig = await makeRig({ tools: parentTools });
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-n",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "narrow" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // The child's SystemEvent (wrapped) carries the effective tool list.
    const sys = events
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.event)
      .find((e) => e.type === "system");
    expect(sys).toBeDefined();
    // Filter omits "Subagent" → child cannot recurse. Has exactly Grep + Read.
    expect(sys!.type === "system" ? sys!.tools : []).toEqual(["Grep", "Read"]);
  });

  it("SC#4: frontmatter with Claude-style unknown keys loads cleanly", async () => {
    await writeAgent(
      "claude-style.md",
      [
        "---",
        "name: claude-style",
        "description: Ported from Claude unedited.",
        "model: claude-opus-4-7",
        "provider: anthropic",
        "permissionMode: acceptEdits",
        "color: blue",
        "effort: high",
        "maxTurns: 20",
        "mcpServers: [slack]",
        "hooks:",
        "  SessionStart:",
        "    - command: echo",
        "memory: project",
        "isolation: worktree",
        "background: false",
        "---",
        "Body.",
      ].join("\n"),
    );
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-c",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "claude-style" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));
    // Just assert no error events and that the subagent ran successfully.
    expect(events.some((e) => e.type === "error")).toBe(false);
    const subEvents = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents[0]!.subagent_type).toBe("claude-style");
  });

  it('SC#5: tools: ["Bash(npm:*)"] → child gets bare Bash (perm pattern stripped)', async () => {
    await writeAgent(
      "perm.md",
      "---\ndescription: Perm test.\ntools: ['Bash(npm:*)']\n---\nBody.\n",
    );
    const parentTools = new ToolRegistry();
    parentTools.register(new BashTool());
    parentTools.register(new ReadTool());
    const rig = await makeRig({ tools: parentTools });
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-p",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "perm" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));
    const sys = events
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.event)
      .find((e) => e.type === "system");
    expect(sys!.type === "system" ? sys!.tools : []).toEqual(["Bash"]);
  });

  it("SC#6: parent iterator yields wrapped SubagentEvent for every child event", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-6",
        toolName: "Subagent",
        input: { description: "x", prompt: "y" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child output."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    const sub = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    // Child loop emits at minimum: system, user, assistant, usage, result.
    const innerTypes = new Set(sub.map((e) => e.event.type));
    expect(innerTypes.has("system")).toBe(true);
    expect(innerTypes.has("user")).toBe(true);
    expect(innerTypes.has("assistant")).toBe(true);
    expect(innerTypes.has("result")).toBe(true);
  });

  it("SC#7: unknown subagent_type → is_error tool_result, no crash", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-7",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "nope" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // Find the tool_result for tu-7 in the next user message.
    const userMsgWithResult = events.find(
      (e) =>
        e.type === "user" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === "tu-7",
        ),
    );
    expect(userMsgWithResult).toBeDefined();
    const result = (
      userMsgWithResult!.type === "user" ? userMsgWithResult.message.content : []
    ) as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: string | unknown }>;
    const tr = result.find((b) => b.type === "tool_result" && b.tool_use_id === "tu-7")!;
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content === "string" && tr.content).toContain("Unknown subagent_type 'nope'");
  });

  it("SC#8: child session row persists with parent linkage in meta", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-8",
        toolName: "Subagent",
        input: { description: "x", prompt: "y" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    await collectEvents(session.run("start"));

    // Walk the store: find a row whose meta.parentSessionId matches the parent.
    const all = await rig.store.list();
    const child = all.find(
      (r) => r.meta?.parentSessionId === session.id,
    );
    expect(child).toBeDefined();
    expect(child!.meta).toEqual({
      parentSessionId: session.id,
      subagentType: "_default",
      subagentRunId: expect.stringMatching(/^sa_/),
      displayName: "Agent #1",
    });
  });

  it("SC#9: subagents cannot spawn subagents — child gets normal unknown-tool result", async () => {
    const rig = await makeRig();
    // MockProvider has one cursor shared across all loops, so the enqueue
    // order MUST match the actual call sequence:
    //   1) parent turn 1 — Subagent(outer)
    //   2) child  turn 1 — attempts Subagent(inner), but the tool is unavailable
    //   3) child  turn 2 — text after receiving the unknown-tool result
    //   4) parent turn 2 — text after the child returns
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-9-1",
        toolName: "Subagent",
        input: { description: "outer", prompt: "do nested work" },
      }),
    );
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-9-2",
        toolName: "Subagent",
        input: { description: "inner", prompt: "leaf work" },
      }),
    );
    rig.provider.enqueue(textTurn("Child handled unavailable tool."));
    rig.provider.enqueue(textTurn("Parent done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    const wrapped = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    expect(wrapped.some((e) => e.event.type === "subagent_event")).toBe(false);
    expect(JSON.stringify(wrapped.map((e) => e.event))).toContain(
      "Tool 'Subagent' is not registered",
    );
  });

  it("SC#10: public surface — Subagent tool name + SubagentEvent + runner exports remain importable", async () => {
    // Import smoke: build/typecheck regressions in the public exports would
    // surface here as TS errors at test compile time. Runtime asserts pin the
    // exact wire names that consumers depend on.
    const subagentsMod = await import("./index.js");
    const eventsMod = await import("../core/events.js");
    const sdkMod = await import("../sdk.js");
    const toolMod = await import("../tools/subagent.js");

    expect(typeof subagentsMod.runSubagent).toBe("function");
    expect(typeof subagentsMod.buildChildTools).toBe("function");
    expect(subagentsMod.DEFAULT_AGENT_TYPE).toBe("_default");
    expect(typeof eventsMod.isSubagentEvent).toBe("function");
    expect(typeof toolMod.SubagentTool).toBe("function");
    expect(toolMod.SUBAGENT_TOOL_NAME).toBe("Subagent");
    // Confirms the public Event union got SubagentEvent (type-level smoke
    // via the runtime guard).
    expect(eventsMod.isSubagentEvent({ type: "system" } as never)).toBe(false);
    // sdk barrel is value-side only (re-exports are types); just ensure import resolves.
    expect(typeof sdkMod.Agent).toBe("function");
  });

  it("hook coverage matrix: PreToolUse/PostToolUse fire in child; UserPromptSubmit/Stop do not", async () => {
    // A trivial read-scoped tool the child can call (auto-allowed).
    const probe: import("../tools/base.js").Tool<Record<string, unknown>> = {
      name: "Probe",
      description: "probe",
      scope: "read",
      parallelSafe: true,
      input_schema: { type: "object", properties: {}, required: [] },
      validate: (raw) => raw,
      async execute() { return { content: "ok", summary: "probe" }; },
      summarize: () => "Probe()",
    };
    const tools = new ToolRegistry();
    tools.register(probe);

    const preCalls: Array<{ tool: string; session: string }> = [];
    const postCalls: Array<{ tool: string; session: string }> = [];
    const upsCalls: Array<{ source: string; session: string }> = [];
    const stopCalls: string[] = [];
    const rig = await makeRig({
      tools,
      hooks: {
        preToolUse: [{ hook: (input, ctx) => { preCalls.push({ tool: input.tool_name, session: ctx.session_id }); } }],
        postToolUse: [{ hook: (input, ctx) => { postCalls.push({ tool: input.tool_name, session: ctx.session_id }); } }],
        userPromptSubmit: [{ hook: (input, ctx) => { upsCalls.push({ source: input.source, session: ctx.session_id }); } }],
        stop: [{ hook: (_input, ctx) => { stopCalls.push(ctx.session_id); } }],
      },
    });

    // parent: Subagent → ... → text ; child: Probe → text
    rig.provider.enqueue(toolCallTurn({ toolUseId: "tu-1", toolName: "Subagent", input: { description: "go", prompt: "probe it" } }));
    rig.provider.enqueue(toolCallTurn({ toolUseId: "ctu-1", toolName: "Probe", input: {} }));
    rig.provider.enqueue(textTurn("child done"));
    rig.provider.enqueue(textTurn("parent done"));

    const session = await rig.agent.session();
    await collectEvents(session.run("start"));

    // PreToolUse/PostToolUse fire tree-wide: parent's Subagent + child's Probe.
    expect(preCalls.map(c => c.tool).sort()).toEqual(["Probe", "Subagent"]);
    expect(postCalls.map(c => c.tool).sort()).toEqual(["Probe", "Subagent"]);
    const probePre = preCalls.find(c => c.tool === "Probe")!;
    expect(probePre.session).not.toBe(session.id); // ran in the child session

    // UserPromptSubmit + Stop fire for the top-level run only.
    expect(upsCalls).toEqual([{ source: "run", session: session.id }]);
    expect(stopCalls).toEqual([session.id]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 (subagent-followup): parallel subagent execution
//
// MockProvider has a single cursor — concurrent stream() calls dequeue in
// microtask order, NOT by calling session. We use SYMMETRIC child scripts and
// assert on the set/invariants of returned values, not on per-child identity.
// See plans/260526-0055-subagent-followup-fixes/phase-04 for the rationale.
// ---------------------------------------------------------------------------

import type { Tool, ToolContext, ToolResult } from "../tools/base.js";

/** Simple barrier — resolves the promise once N arrivals reach arriveAndWait(). */
function makeBarrier(expected: number, timeoutMs = 2000): { arriveAndWait: () => Promise<void>; released: boolean } {
  let arrivals = 0;
  let release!: () => void;
  let rejectTimeout!: (e: Error) => void;
  const waiter = new Promise<void>((res, rej) => {
    release = res;
    rejectTimeout = rej;
  });
  const t = setTimeout(() => rejectTimeout(new Error(`Barrier timed out after ${timeoutMs}ms`)), timeoutMs);
  const state = { released: false };
  return {
    arriveAndWait: async () => {
      arrivals++;
      if (arrivals >= expected) {
        clearTimeout(t);
        state.released = true;
        release();
      }
      await waiter;
    },
    get released() { return state.released; },
  };
}

class BarrierE2ETool implements Tool<Record<string, unknown>> {
  readonly name = "BarrierE2E";
  readonly description = "rendezvous tool for concurrency proof";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  constructor(private readonly barrier: { arriveAndWait: () => Promise<void> }) {}
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return "barrier"; }
  async execute(): Promise<ToolResult> {
    await this.barrier.arriveAndWait();
    return { content: "rendezvoused", summary: "barrier" };
  }
}

class AbortAwareSleepTool implements Tool<Record<string, unknown>> {
  readonly name = "AbortableSleep";
  readonly description = "waits until signal aborts; throws AbortError on abort";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = { type: "object" as const, properties: {} };
  validate(raw: Record<string, unknown>): Record<string, unknown> { return raw; }
  summarize(): string { return "sleep"; }
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    await new Promise<void>((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    return { content: "should-not-reach", summary: "sleep" };
  }
}

// MockProvider helpers — parent vs child request discrimination by system prompt.
// The named worker subagent's body contains "CHILD_BODY_MARKER"; the parent's
// system prompt does not. enqueueFor uses these predicates so concurrent
// stream() calls from two children don't race the single cursor.
function isChildReq(req: ProviderRequest): boolean {
  return req.system?.some(
    (b) => b.type === "text" && b.text.includes("CHILD_BODY_MARKER"),
  ) ?? false;
}
function isParentReq(req: ProviderRequest): boolean { return !isChildReq(req); }

/** Parent turn that spawns two named "worker" subagents in one assistant message. */
function spawnTwoWorkersTurn(): { events: ProviderStreamEvent[] } {
  const inputJson = JSON.stringify({ description: "go", prompt: "do work", subagent_type: "worker" });
  return {
    events: [
      { type: "message_start", model: "test-model" },
      { type: "tool_use_start", id: "tu-A", name: "Subagent" },
      { type: "tool_use_input_delta", id: "tu-A", json_delta: inputJson },
      { type: "tool_use_end", id: "tu-A" },
      { type: "tool_use_start", id: "tu-B", name: "Subagent" },
      { type: "tool_use_input_delta", id: "tu-B", json_delta: inputJson },
      { type: "tool_use_end", id: "tu-B" },
      { type: "message_end", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  };
}

describe("subagent e2e — parallel execution (Phase 4)", () => {
  beforeEach(async () => {
    // Worker subagent definition — body carries the discriminator marker so
    // isChildReq can tell child requests from parent requests.
    await writeAgent("worker.md", "---\ndescription: worker\n---\nCHILD_BODY_MARKER\n");
  });

  it("two Subagent calls in one parent turn run concurrently (barrier releases)", async () => {
    const barrier = makeBarrier(2, 2000);
    const tools = new ToolRegistry();
    tools.register(new BarrierE2ETool(barrier));
    const rig = await makeRig({ tools });

    rig.provider.enqueueFor(isParentReq, spawnTwoWorkersTurn());
    rig.provider.enqueueFor(isParentReq, textTurn("parent done"));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-1", toolName: "BarrierE2E", input: {} }));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-2", toolName: "BarrierE2E", input: {} }));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));

    const session = await rig.agent.session();
    const t0 = Date.now();
    const events = await collectEvents(session.run("spawn two"));
    const elapsed = Date.now() - t0;

    expect(barrier.released).toBe(true);
    expect(elapsed).toBeLessThan(2000); // if back-to-back, barrier would have timed out

    const subEvents = events.filter((e): e is SubagentEvent => e.type === "subagent_event");
    const runIds = new Set(subEvents.map((e) => e.subagent_run_id));
    expect(runIds.size).toBe(2);
  });

  it("SubagentEvent streams interleave for concurrent subagents", async () => {
    const barrier = makeBarrier(2, 2000);
    const tools = new ToolRegistry();
    tools.register(new BarrierE2ETool(barrier));
    const rig = await makeRig({ tools });

    rig.provider.enqueueFor(isParentReq, spawnTwoWorkersTurn());
    rig.provider.enqueueFor(isParentReq, textTurn("parent done"));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-1", toolName: "BarrierE2E", input: {} }));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-2", toolName: "BarrierE2E", input: {} }));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("spawn two"));

    const subEvents = events.filter((e): e is SubagentEvent => e.type === "subagent_event");
    expect(subEvents.length).toBeGreaterThan(2);
    const runIds = [...new Set(subEvents.map((e) => e.subagent_run_id))];
    expect(runIds.length).toBe(2);

    // Interleaving: ranges of A's and B's events overlap (proves not strictly serial).
    const firstA = subEvents.findIndex((e) => e.subagent_run_id === runIds[0]);
    const lastA = subEvents.length - 1 - [...subEvents].reverse().findIndex((e) => e.subagent_run_id === runIds[0]);
    const firstB = subEvents.findIndex((e) => e.subagent_run_id === runIds[1]);
    const lastB = subEvents.length - 1 - [...subEvents].reverse().findIndex((e) => e.subagent_run_id === runIds[1]);
    const overlap = !(lastA < firstB || lastB < firstA);
    expect(overlap).toBe(true);
  });

  it("abort cancels in-flight concurrent subagents — no orphan tool_call_start", async () => {
    const tools = new ToolRegistry();
    tools.register(new AbortAwareSleepTool());
    const rig = await makeRig({ tools });

    rig.provider.enqueueFor(isParentReq, spawnTwoWorkersTurn());
    rig.provider.enqueueFor(isParentReq, textTurn("parent done"));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-1", toolName: "AbortableSleep", input: {} }));
    rig.provider.enqueueFor(isChildReq, toolCallTurn({ toolUseId: "ctu-2", toolName: "AbortableSleep", input: {} }));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));
    rig.provider.enqueueFor(isChildReq, textTurn("done"));

    const session = await rig.agent.session();
    const runProm = collectEvents(session.run("spawn two"));
    await new Promise((r) => setTimeout(r, 100));
    session.abort();
    const events = await runProm;

    // Invariant: every tool_call_start has a matching tool_call_end (real OR synthetic).
    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts.length).toBe(ends.length);
    expect(starts.length).toBeGreaterThanOrEqual(2); // at least the two Subagent tool_call_starts

    const subEvents = events.filter((e): e is SubagentEvent => e.type === "subagent_event");
    const runIds = new Set(subEvents.map((e) => e.subagent_run_id));
    expect(runIds.size).toBe(2);
  });

  it("two concurrent parent-level TaskUpdates on same task — additive edges accumulate", async () => {
    // Two TaskUpdate calls in ONE parent assistant turn land in the same
    // parallel batch (TaskUpdate.parallelSafe = true). Verified safe per
    // Phase 3 plan: sqlite uses synchronous transactions; in-memory store
    // has no awaits between read and write.
    const rig = await makeRig();
    const session = await rig.agent.session();
    const store = rig.store;
    await store.createTask(session.id, { subject: "t1", description: "task one", active_form: "doing 1" });
    await store.createTask(session.id, { subject: "t2", description: "task two", active_form: "doing 2" });
    await store.createTask(session.id, { subject: "t3", description: "task three", active_form: "doing 3" });

    // Parent turn 1: two TaskUpdate tool_use blocks targeting the same task.
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "tool_use_start", id: "tu-u1", name: "TaskUpdate" },
        { type: "tool_use_input_delta", id: "tu-u1", json_delta: JSON.stringify({ task_id: "1", add_blocks: ["2"] }) },
        { type: "tool_use_end", id: "tu-u1" },
        { type: "tool_use_start", id: "tu-u2", name: "TaskUpdate" },
        { type: "tool_use_input_delta", id: "tu-u2", json_delta: JSON.stringify({ task_id: "1", add_blocks: ["3"] }) },
        { type: "tool_use_end", id: "tu-u2" },
        { type: "message_end", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });
    rig.provider.enqueue(textTurn("done"));

    const events = await collectEvents(session.run("update twice"));

    // Both tool calls completed without error
    const ends = events.filter((e) => e.type === "tool_call_end") as Array<Extract<Event, { type: "tool_call_end" }>>;
    expect(ends).toHaveLength(2);
    for (const e of ends) expect(e.is_error).toBe(false);

    const task1 = await store.getTask(session.id, "1");
    expect(task1).toBeDefined();
    expect(new Set(task1!.blocks ?? [])).toEqual(new Set(["2", "3"]));
  });
});
