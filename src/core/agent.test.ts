import { describe, expect, it, mock } from "bun:test";
import path from "node:path";
import { Agent } from "./agent.js";
import { getAgentInternals } from "./agent.js";
import { ConfigError } from "./errors.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { SKAWLD_VERSION } from "./version.js";
import type { BaseProvider } from "../providers/base.js";
import type { PermissionRule } from "../permissions/rules.js";

const SKILLS_FIXTURE_DIR = path.resolve(
  import.meta.dir, "..", "..", "tests", "fixtures", "skills", "integration",
);

/** Reads the live rule list out of an Agent's permission engine. */
function engineRules(agent: Agent): PermissionRule[] {
  const engine = getAgentInternals(agent).permissionEngine as unknown as {
    opts: { rules: PermissionRule[] };
  };
  return engine.opts.rules;
}

// Minimal provider stub that satisfies the BaseProvider interface.
function makeProvider(): BaseProvider {
  return {
    id: "test-provider",
    contextWindow: (_model: string) => 200_000,
    stream: async function* () { /* never called in these tests */ },
  };
}

describe("Agent constructor", () => {
  it("throws ConfigError when provider is missing", () => {
    expect(
      () => new Agent({ provider: undefined as any, model: "test-model" })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when model is missing", () => {
    expect(
      () => new Agent({ provider: makeProvider(), model: "" as any })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when maxRetries is invalid", () => {
    expect(
      () => new Agent({
        provider: makeProvider(),
        model: "test-model",
        maxRetries: -1,
      })
    ).toThrow(ConfigError);
    expect(
      () => new Agent({
        provider: makeProvider(),
        model: "test-model",
        maxRetries: 1.5,
      })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when maxTurns or maxOutputTokens is invalid", () => {
    const base = { provider: makeProvider(), model: "test-model" };
    expect(() => new Agent({ ...base, maxTurns: 0 })).toThrow(ConfigError);
    expect(() => new Agent({ ...base, maxTurns: 2.5 })).toThrow(ConfigError);
    expect(() => new Agent({ ...base, maxOutputTokens: 0 })).toThrow(ConfigError);
    expect(() => new Agent({ ...base, maxOutputTokens: -10 })).toThrow(ConfigError);
  });

  it("throws ConfigError for invalid hook config and accepts valid hooks", () => {
    const base = { provider: makeProvider(), model: "test-model" };
    expect(() => new Agent({ ...base, hooks: { preToolUse: [{ matcher: "Bash" } as any] } })).toThrow(ConfigError);
    expect(() => new Agent({ ...base, hooks: { stop: [{ timeoutMs: 0, hook: () => undefined }] } })).toThrow(ConfigError);
    // A valid hook registration constructs and exposes a hookRunner.
    const agent = new Agent({ ...base, hooks: { stop: [{ hook: () => undefined }] } });
    expect(getAgentInternals(agent).hookRunner.hasStop).toBe(true);
  });

  it("applies default values", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    expect(internal.maxRetries).toBe(5);
    // No Agent-level default: undefined when the user didn't set it. Providers
    // decide their own behavior — OpenAI omits from the wire, Anthropic falls
    // back to 32768 internally because its API requires the field.
    expect(internal.maxOutputTokens).toBeUndefined();
    // Default tool-call concurrency cap is 10, resolved once at construction
    // from SKAWLD_MAX_TOOL_CONCURRENCY env var.
    expect(internal.toolConcurrency).toBe(10);
    expect(internal.includePartialMessages).toBe(false);
    expect(internal.maxTurns).toBe(Infinity);
    expect(internal.cwd).toBe(process.cwd());
    // Phase 5: defaultCompaction is now wired as the default
    expect(internal.compaction).toBeDefined();
    expect(internal.compaction!.id).toBe("default-keep-recent-10");
  });

  it("builds systemBlocks at construction", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    expect(internal.systemBlocks.length).toBeGreaterThan(0);
    // Every block should have type "text".
    for (const block of internal.systemBlocks) {
      expect(block.type).toBe("text");
    }
  });

  it("system prompt env block contains the real package version (not 0.0.0-dev)", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    const envBlock = internal.systemBlocks.find(b =>
      b.text.includes("skawld version:")
    );
    expect(envBlock).toBeDefined();
    expect(envBlock!.text).toContain(`skawld version: ${SKAWLD_VERSION}`);
    expect(envBlock!.text).not.toContain("0.0.0-dev");
    // Confirm the constant itself is a real semver-shaped string, not the fallback.
    expect(SKAWLD_VERSION).not.toBe("0.0.0-dev");
    expect(SKAWLD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("toolConcurrency observes SKAWLD_MAX_TOOL_CONCURRENCY at construction time", () => {
    const prior = process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
    process.env.SKAWLD_MAX_TOOL_CONCURRENCY = "3";
    try {
      const store = new InMemorySessionStore();
      const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
      expect(getAgentInternals(agent).toolConcurrency).toBe(3);
    } finally {
      if (prior === undefined) delete process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
      else process.env.SKAWLD_MAX_TOOL_CONCURRENCY = prior;
    }
  });

  it("populates default tools", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
    const internal = getAgentInternals(agent);

    const names = internal.tools.list().map(t => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Bash");
  });
});

describe("Agent.session()", () => {
  it("returns a Session with empty providerView for a new id", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    const sess = await agent.session();
    expect(sess.messageCount).toBe(0);
  });

  it("resumes an existing session by id with the right messageCount", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    // Create a session and append some messages.
    const sess1 = await agent.session();
    await store.appendMessages(sess1.id, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);

    // Resume the same session.
    const sess2 = await agent.session({ id: sess1.id });
    expect(sess2.messageCount).toBe(2);
  });

  it("passes custom meta to the store", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    const sess = await agent.session({ meta: { project: "skawld" } });
    const record = await store.load(sess.id);
    expect(record?.meta.project).toBe("skawld");
  });
});

describe("Agent.close()", () => {
  it("calls sessionStore.close() when a store was provided", async () => {
    const store = new InMemorySessionStore();
    const closeFn = mock(async () => {});
    (store as any).close = closeFn;

    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
    await agent.close();

    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no explicit sessionStore was provided and session() was never called", async () => {
    const agent = new Agent({ provider: makeProvider(), model: "m" });
    // Should complete without creating a SQLite file or throwing.
    await expect(agent.close()).resolves.toBeUndefined();
  });
});

describe("Agent — shared permission rules array isolation (C4)", () => {
  it("connectSkills does not mutate the caller's rules array; engines stay independent", async () => {
    // One rules array shared by reference between two Agents.
    const sharedRules: PermissionRule[] = [
      { kind: "tool", tool: "Read", decision: "allow" },
    ];

    const makeAgentWithSharedRules = () =>
      new Agent({
        provider: makeProvider(),
        model: "m",
        sessionStore: new InMemorySessionStore(),
        configDir: SKILLS_FIXTURE_DIR,
        permissions: { rules: sharedRules },
      });

    const agentA = makeAgentWithSharedRules();
    const agentB = makeAgentWithSharedRules();

    // Skills (and their auto-allow Skill rules) load lazily on session().
    await agentA.session();
    await agentB.session();

    // The caller's array is untouched — no skawld-internal Skill rule leaked in.
    expect(sharedRules).toEqual([{ kind: "tool", tool: "Read", decision: "allow" }]);
    expect(sharedRules.some(r => r.kind === "tool" && r.tool === "Skill")).toBe(false);

    // The fixture has exactly one informational skill (commit) → exactly one
    // auto-allow Skill rule per engine, and the two engines do not contaminate
    // each other (no doubling from the shared source array).
    const skillRulesA = engineRules(agentA).filter(r => r.kind === "tool" && r.tool === "Skill");
    const skillRulesB = engineRules(agentB).filter(r => r.kind === "tool" && r.tool === "Skill");
    expect(skillRulesA).toHaveLength(1);
    expect(skillRulesB).toHaveLength(1);

    await agentA.close();
    await agentB.close();
  });
});
