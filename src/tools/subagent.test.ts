import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, getAgentInternals } from "../core/agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "../core/_test-mock-provider.js";
import { DEFAULT_AGENT_TYPE } from "../subagents/default-agent.js";
import { SubagentTool, SUBAGENT_TOOL_NAME } from "./subagent.js";
import type { ProviderRequest, ProviderStreamEvent } from "../providers/base.js";
import type { ToolContext } from "./base.js";
import type { SubagentInput } from "./subagent.js";
import type { Event, SubagentEvent } from "../core/events.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let configDir: string;
let agentsDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "skawld-subagent-tool-"));
  agentsDir = path.join(configDir, "agents");
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function writeAgent(file: string, content: string): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, file), content);
}

function singleTextTurn(text: string): { events: ProviderStreamEvent[] } {
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

function emptyTextTurn(): { events: ProviderStreamEvent[] } {
  return {
    events: [
      { type: "message_start", model: "test-model" },
      {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

function providerErrorTurn() {
  return {
    events: [{ type: "message_start", model: "test-model" }],
    throwAfterIndex: 0,
    throwBefore: Object.assign(new Error("provider failed"), { name: "ProviderError" }),
  };
}

interface Rig {
  agent: Agent;
  provider: MockProvider;
  parentSessionId: string;
  capturedRequests: ProviderRequest[];
}

async function makeRig(): Promise<Rig> {
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
    permissions: { mode: "yolo" },
  });
  const parent = await agent.session();
  return { agent, provider, parentSessionId: parent.id, capturedRequests };
}

function getSubagentTool(rig: Rig): SubagentTool {
  const ai = getAgentInternals(rig.agent);
  const tool = ai.tools.get(SUBAGENT_TOOL_NAME);
  expect(tool).toBeDefined();
  return tool as SubagentTool;
}

function makeCtx(rig: Rig, emit?: (e: Event) => void): ToolContext {
  const ai = getAgentInternals(rig.agent);
  return {
    cwd: ai.cwd,
    signal: new AbortController().signal,
    fileReadTracker: ai.tools.get("Read") ? ({} as never) : ({} as never),
    sessionId: rig.parentSessionId,
    runId: "test-run-id",
    sessionStore: ai.getStore(),
    ...(emit !== undefined && { emit }),
  };
}

// ---------------------------------------------------------------------------
// Tool description
// ---------------------------------------------------------------------------

describe("SubagentTool — description (catalog)", () => {
  it("lists disk agents and OMITS the built-in default", async () => {
    await writeAgent("researcher.md", "---\ndescription: Researches.\n---\nResearch body.\n");
    await writeAgent("reviewer.md", "---\ndescription: Reviews.\n---\nReview body.\n");

    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    const desc = tool.description;

    expect(desc).toContain("researcher: Researches.");
    expect(desc).toContain("reviewer: Reviews.");
    expect(desc).not.toContain(DEFAULT_AGENT_TYPE);
    expect(desc).toContain("Omit `subagent_type`");
  });

  it("shows only the trailer when no disk agents are loaded", async () => {
    const rig = await makeRig();
    const desc = getSubagentTool(rig).description;
    expect(desc).not.toContain("Available subagent types:");
    expect(desc).toContain("Omit `subagent_type`");
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("SubagentTool — validate()", () => {
  it("rejects empty description", async () => {
    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    expect(() => tool.validate({ description: "", prompt: "x" })).toThrow();
  });

  it("rejects empty prompt", async () => {
    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    expect(() => tool.validate({ description: "x", prompt: "" })).toThrow();
  });

  it("rejects non-string subagent_type", async () => {
    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    expect(() => tool.validate({ description: "x", prompt: "y", subagent_type: 42 })).toThrow();
  });

  it("accepts valid input including optional subagent_type", async () => {
    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    expect(tool.validate({ description: "d", prompt: "p", subagent_type: "x" })).toEqual({
      description: "d",
      prompt: "p",
      subagent_type: "x",
    });
  });
});

// ---------------------------------------------------------------------------
// execute() — happy path + unknown type + display name counter
// ---------------------------------------------------------------------------

describe("SubagentTool — execute() default spawn", () => {
  it("default spawn (no subagent_type) → 'Agent #1' displayName, returns final text", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("Hello from default."));

    const tool = getSubagentTool(rig);
    const emitted: SubagentEvent[] = [];
    const ctx = makeCtx(rig, (e) => {
      if (e.type === "subagent_event") emitted.push(e);
    });

    const input: SubagentInput = { description: "test", prompt: "go" };
    const result = await tool.execute(input, ctx);

    expect(result.is_error).toBe(false);
    expect(result.content).toBe("Hello from default.");
    expect(emitted.length).toBeGreaterThan(0);
    // First default spawn within this parent session → Agent #1.
    expect(emitted[0]!.display_name).toBe("Agent #1");
    expect(emitted[0]!.subagent_type).toBe(DEFAULT_AGENT_TYPE);
  });

  it("counter increments per parent session (Agent #1, #2, ...)", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("first"));
    rig.provider.enqueue(singleTextTurn("second"));

    const tool = getSubagentTool(rig);
    const names: string[] = [];
    const ctx = makeCtx(rig, (e) => {
      if (e.type === "subagent_event" && (e as SubagentEvent).event.type === "system") {
        names.push((e as SubagentEvent).display_name);
      }
    });

    await tool.execute({ description: "a", prompt: "1" }, ctx);
    await tool.execute({ description: "b", prompt: "2" }, ctx);

    expect(names).toEqual(["Agent #1", "Agent #2"]);
  });
});

describe("SubagentTool — execute() named spawn", () => {
  it("named subagent_type uses the disk agent body; displayName == frontmatter.name", async () => {
    await writeAgent(
      "reviewer.md",
      "---\ndescription: Review code.\n---\nYou are a code reviewer.\n",
    );
    const rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("Reviewed."));

    const tool = getSubagentTool(rig);
    const emitted: SubagentEvent[] = [];
    const ctx = makeCtx(rig, (e) => {
      if (e.type === "subagent_event") emitted.push(e);
    });

    const result = await tool.execute(
      { description: "review", prompt: "check this", subagent_type: "reviewer" },
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toBe("Reviewed.");
    expect(emitted[0]!.display_name).toBe("reviewer");
    expect(emitted[0]!.subagent_type).toBe("reviewer");

    // The child's provider request should carry the agent body as user-instructions.
    expect(rig.capturedRequests.length).toBeGreaterThan(0);
    const childReq = rig.capturedRequests[rig.capturedRequests.length - 1]!;
    const userInstrBlock = (childReq.system as Array<{ type: string; text: string }>).find(
      (b) => b.type === "text" && b.text.includes("User-provided instructions"),
    );
    expect(userInstrBlock).toBeDefined();
    expect(userInstrBlock!.text).toContain("You are a code reviewer.");
  });

  it("a disk agent named 'general-purpose' wins over the built-in alias", async () => {
    await writeAgent(
      "general-purpose.md",
      "---\ndescription: User's own general agent.\n---\nYou are the user's general agent.\n",
    );
    const rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("from disk agent"));

    const tool = getSubagentTool(rig);
    const emitted: SubagentEvent[] = [];
    const ctx = makeCtx(rig, (e) => {
      if (e.type === "subagent_event") emitted.push(e);
    });

    const result = await tool.execute(
      { description: "go", prompt: "do it", subagent_type: "general-purpose" },
      ctx,
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toBe("from disk agent");
    // Resolves to the disk agent, not DEFAULT_AGENT_TYPE.
    expect(emitted[0]!.subagent_type).toBe("general-purpose");
    const childReq = rig.capturedRequests[rig.capturedRequests.length - 1]!;
    const userInstrBlock = (childReq.system as Array<{ type: string; text: string }>).find(
      (b) => b.type === "text" && b.text.includes("User-provided instructions"),
    );
    expect(userInstrBlock!.text).toContain("You are the user's general agent.");
  });
});

describe("SubagentTool — execute() unknown subagent_type", () => {
  it("unknown subagent_type → is_error result with helpful catalog", async () => {
    await writeAgent("researcher.md", "---\ndescription: Researches.\n---\nBody.\n");
    const rig = await makeRig();

    const tool = getSubagentTool(rig);
    const ctx = makeCtx(rig);

    const result = await tool.execute(
      { description: "x", prompt: "y", subagent_type: "nonexistent" },
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Unknown subagent_type 'nonexistent'");
    expect(result.content).toContain("researcher");
    expect(result.content).toContain("omit subagent_type");
  });

  it("unknown subagent_type when NO named agents loaded → hint to omit", async () => {
    const rig = await makeRig();
    const tool = getSubagentTool(rig);
    const ctx = makeCtx(rig);

    const result = await tool.execute(
      { description: "x", prompt: "y", subagent_type: "nonexistent" },
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No named subagents are loaded");
    expect(result.content).toContain("omit subagent_type");
  });
});

describe("SubagentTool — execute() empty subagent_type coercion", () => {
  // Models tend to fill optional string fields with "" instead of omitting
  // them. We coerce empty / whitespace-only / "general-purpose" to the
  // built-in default rather than 404-ing.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["claude alias 'general-purpose'", "general-purpose"],
  ])("subagent_type=%s → spawns the default agent", async (_label, value) => {
    const rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("default child output"));
    const tool = getSubagentTool(rig);
    const ctx = makeCtx(rig);

    const result = await tool.execute(
      { description: "go", prompt: "do the thing", subagent_type: value },
      ctx,
    );

    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe("default child output");
  });
});

describe("SubagentTool — execute() result errors", () => {
  it("returns is_error when the child completes without text output", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(emptyTextTurn());
    const tool = getSubagentTool(rig);
    const ctx = makeCtx(rig);

    const result = await tool.execute({ description: "silent", prompt: "say nothing" }, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Subagent produced no text output.");
  });

  it("includes child error details in the parent-visible result", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(providerErrorTurn());
    const tool = getSubagentTool(rig);
    const ctx = makeCtx(rig);

    const result = await tool.execute({ description: "fail", prompt: "trigger failure" }, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Subagent encountered an error: ProviderError: provider failed.");
  });
});
