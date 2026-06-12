import { describe, test, expect } from "bun:test";
import { AskUserTool } from "./ask-user.js";
import { AbortError, ToolExecutionError } from "../core/errors.js";
import type { AskUserHandler, AskUserResponse } from "./ask-user.js";
import type { ToolContext } from "./base.js";

// Minimal ToolContext stub — AskUserTool only needs signal, runId, toolUseId.
function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
    fileReadTracker: {} as any,
    sessionId: "sess-1",
    runId: "run-1",
    toolUseId: "toolu-1",
    sessionStore: {} as any,
  };
}

const SINGLE_Q = {
  question: "Which backend should we use?",
  header: "Backend",
  options: [
    { label: "SQLite", description: "Embedded, no server" },
    { label: "PostgreSQL", description: "Full relational DB" },
  ],
  multi_select: false,
};

function makeTool(handler: AskUserHandler): AskUserTool {
  return new AskUserTool(handler);
}

// ---------------------------------------------------------------------------
// validate() — shape rules
// ---------------------------------------------------------------------------
describe("AskUserTool.validate()", () => {
  test("accepts a minimal valid input", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["SQLite"] }] }));
    const input = tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] }] });
    expect(input.questions).toHaveLength(1);
    expect(input.questions[0]!.multi_select).toBe(false);
  });

  test("defaults multi_select to false", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["A"] }] }));
    const raw = {
      questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] }],
    };
    const input = tool.validate(raw);
    expect(input.questions[0]!.multi_select).toBe(false);
  });

  test("preserves explicit multi_select: true", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["A", "B"] }] }));
    const raw = {
      questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }], multi_select: true }],
    };
    const input = tool.validate(raw);
    expect(input.questions[0]!.multi_select).toBe(true);
  });

  test("rejects 0 questions", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() => tool.validate({ questions: [] })).toThrow(ToolExecutionError);
  });

  test("rejects 5 questions", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    expect(() => tool.validate({ questions: [q, q, q, q, q] })).toThrow(ToolExecutionError);
  });

  test("rejects empty question string", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "", header: "H", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects empty header string", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects header longer than 12 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "VeryLongHeader", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("accepts header of exactly 12 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const input = tool.validate({
      questions: [{ question: "Q?", header: "123456789012", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(input.questions[0]!.header).toBe("123456789012");
  });

  test("rejects 1 option (needs 2–4)", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects 5 options", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const opts = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }];
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: opts }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects duplicate option labels", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "A" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects empty option label", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("accepts 4 questions (max)", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const input = tool.validate({ questions: [q, q, q, q] });
    expect(input.questions).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// summarize()
// ---------------------------------------------------------------------------
describe("AskUserTool.summarize()", () => {
  test("single question", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const input = tool.validate({ questions: [{ question: "Which backend?", header: "Backend", options: [{ label: "A" }, { label: "B" }] }] });
    expect(tool.summarize(input)).toBe('Ask user: "Which backend?"');
  });

  test("multiple questions appends count", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const input = tool.validate({ questions: [q, q, q] });
    expect(tool.summarize(input)).toBe('Ask user: "Q?" (+2 more)');
  });

  test("truncates long first question to 60 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const longQ = "A".repeat(70) + "?";
    const input = tool.validate({ questions: [{ question: longQ, header: "H", options: [{ label: "A" }, { label: "B" }] }] });
    const summary = tool.summarize(input);
    // 60 chars + ellipsis
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// execute() — happy paths
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — answers", () => {
  test("renders single answer", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["SQLite"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(typeof result.content).toBe("string");
    const content = result.content as string;
    expect(content).toContain("User answered:");
    expect(content).toContain("[Backend] Which backend should we use?");
    expect(content).toContain("→ SQLite");
    expect(result.summary).toBe("User answered 1 question");
  });

  test("renders multi-select answer with comma join", async () => {
    const q = { question: "Platforms?", header: "Platforms", options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }], multi_select: true };
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["macOS", "Linux"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("→ macOS, Linux");
  });

  test("renders free text answer", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["something custom"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.content).toContain("→ something custom");
  });

  test("handler receives ctx.toolUseId as tool_use_id", async () => {
    let seenId: string | undefined;
    const handler: AskUserHandler = async (req) => {
      seenId = req.tool_use_id;
      return { answers: [{ selected: ["SQLite"] }] };
    };
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    await tool.execute(input, makeCtx());
    expect(seenId).toBe("toolu-1");
  });

  test("summary pluralises for multiple questions", async () => {
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const handler: AskUserHandler = async () => ({
      answers: [{ selected: ["A"] }, { selected: ["B"] }],
    });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [q, q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.summary).toBe("User answered 2 questions");
  });
});

// ---------------------------------------------------------------------------
// execute() — declined
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — declined", () => {
  test("decline without reason", async () => {
    const handler: AskUserHandler = async () => ({ declined: true });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("The user declined to answer");
    expect(result.content).not.toContain("(reason:");
    expect(result.summary).toBe("User declined to answer");
  });

  test("decline with reason", async () => {
    const handler: AskUserHandler = async () => ({ declined: true, reason: "in a meeting" });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("(reason: in a meeting)");
  });
});

// ---------------------------------------------------------------------------
// execute() — invalid handler response
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — invalid response", () => {
  test("answers length mismatch", async () => {
    const handler: AskUserHandler = async () => ({
      answers: [{ selected: ["A"] }, { selected: ["B"] }],
    });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("expected 1 answer");
  });

  test("selected is not an array", async () => {
    const handler: AskUserHandler = async () =>
      ({ answers: [{ selected: "SQLite" }] } as any);
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("selected must be an array");
  });

  test("selected is empty array", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: [] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
  });

  test("null response", async () => {
    const handler: AskUserHandler = async () => null as any;
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("expected an object");
  });

  test("declined: false is invalid, not a decline", async () => {
    const handler: AskUserHandler = async () => ({ declined: false } as any);
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("declined must be true");
  });

  test("multi_select: false but two selections", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["A", "B"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exactly one entry");
  });
});

// ---------------------------------------------------------------------------
// execute() — handler throws
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — handler throws", () => {
  test("non-abort error yields is_error result with message", async () => {
    const handler: AskUserHandler = async () => {
      throw new Error("something broke");
    };
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("AskUser failed: something broke");
  });
});

// ---------------------------------------------------------------------------
// execute() — abort
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — abort", () => {
  test("pre-aborted signal throws AbortError immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    // Handler never resolves
    const handler: AskUserHandler = () => new Promise(() => {});
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    await expect(tool.execute(input, makeCtx(ac.signal))).rejects.toBeInstanceOf(AbortError);
  });

  test("signal fires mid-run throws AbortError and ignores late handler", async () => {
    const ac = new AbortController();
    let resolveHandler!: (v: AskUserResponse) => void;
    const handler: AskUserHandler = () => new Promise<AskUserResponse>(r => { resolveHandler = r; });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const execPromise = tool.execute(input, makeCtx(ac.signal));
    // Abort after scheduling
    queueMicrotask(() => ac.abort());
    await expect(execPromise).rejects.toBeInstanceOf(AbortError);
    // Handler resolving after abort should be silently ignored (no throw)
    resolveHandler({ answers: [{ selected: ["SQLite"] }] });
  });
});

// ---------------------------------------------------------------------------
// Agent wiring: AskUser registered when handler provided
// ---------------------------------------------------------------------------
describe("Agent wiring", () => {
  test("AskUserTool is present in registry when askUser provided", async () => {
    const { Agent } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");

    // Minimal mock provider
    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const handler: AskUserHandler = async () => ({ declined: true });
    const agent = new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
      askUser: handler,
    });

    const { getAgentInternals } = await import("../core/agent.js");
    const ai = getAgentInternals(agent);
    const names = ai.tools.list().map(t => t.name);
    expect(names).toContain("AskUser");
    await agent.close();
  });

  test("AskUserTool is absent when askUser not provided", async () => {
    const { Agent, getAgentInternals } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");

    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const agent = new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
    });

    const ai = getAgentInternals(agent);
    const names = ai.tools.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
    await agent.close();
  });

  test("throws ConfigError when AskUser already registered and askUser handler provided", async () => {
    const { Agent } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");
    const { ToolRegistry } = await import("./registry.js");

    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const handler: AskUserHandler = async () => ({ declined: true });
    // Pre-register a tool named "AskUser" in a custom registry
    const registry = new ToolRegistry();
    const fakeAskUser = new AskUserTool(handler);
    registry.register(fakeAskUser);

    expect(() => new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
      tools: registry,
      askUser: handler,
    })).toThrow(/AskUser/);
  });
});

// ---------------------------------------------------------------------------
// buildChildTools excludes AskUser
// ---------------------------------------------------------------------------
describe("buildChildTools", () => {
  test("excludes AskUser even in wildcard filter", async () => {
    const { buildChildTools } = await import("../subagents/runner.js");
    const { ToolRegistry } = await import("./registry.js");

    const registry = new ToolRegistry();
    const handler: AskUserHandler = async () => ({ declined: true });
    registry.register(new AskUserTool(handler));

    const child = buildChildTools(registry, undefined); // wildcard
    const names = child.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
  });

  test("excludes AskUser when explicitly listed in filter", async () => {
    const { buildChildTools } = await import("../subagents/runner.js");
    const { ToolRegistry } = await import("./registry.js");

    const registry = new ToolRegistry();
    const handler: AskUserHandler = async () => ({ declined: true });
    registry.register(new AskUserTool(handler));

    const child = buildChildTools(registry, ["AskUser"]);
    const names = child.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
  });
});
