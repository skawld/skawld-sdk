/** Agent class. See docs/05-agent-loop.html#agent. */

import os from "node:os";
import { SKAWLD_VERSION } from "./version.js";
import { ConfigError } from "./errors.js";
import { buildSystemBlocks } from "./system-prompt.js";
import { PermissionEngine } from "../permissions/engine.js";
import { defaultTools, ToolRegistry } from "../tools/registry.js";
import { connectMcpServers, type McpConnection } from "../tools/mcp/client.js";
import type { McpServerConfig } from "../tools/mcp/config.js";
import { SqliteSessionStore } from "../sessions/sqlite.js";
import { Session, getSessionInternals } from "./session.js";
import { getDefaultToolConcurrency } from "./merge-generators.js";
import type { BaseProvider } from "../providers/base.js";
import type { SystemBlock } from "../providers/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { PermissionMode } from "./types.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { PermissionRule } from "../permissions/rules.js";
import { defaultCompaction } from "./compaction.js";
import type { CompactionStrategy } from "./compaction.js";
import { HookRunner } from "./hooks.js";
import type { Hooks } from "./hooks.js";
import type { ModelId } from "./types.js";
import path from "node:path";
import { loadSkillsFromDir } from "../skills/loader.js";
import { buildSkillListing } from "../skills/listing.js";
import type { Skill } from "../skills/types.js";
import { SkillTool } from "../tools/skill.js";
import { SubagentTool } from "../tools/subagent.js";
import { buildAgentRegistry } from "../subagents/registry.js";
import { loadAgentsFromDir } from "../subagents/loader.js";
import type { AgentRegistry } from "../subagents/registry.js";
import type { SessionInternal } from "./session.js";

export interface AgentOptions {
  /** LLM provider. Required. */
  provider: BaseProvider;
  /** Model id string. Required (skawld has no default). */
  model: ModelId;
  /** Tool registry. If omitted, defaults to the built-in tools. */
  tools?: ToolRegistry;
  /**
   * External MCP servers to connect, keyed by server name. Their tools are
   * exposed to the model as `mcp__<server>__<tool>`. Servers connect lazily on
   * the first session() call and disconnect on close(). Shape mirrors the
   * Claude Agent SDK's mcpServers option.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission configuration. */
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
    canUseTool?: CanUseTool;
  };
  /**
   * Where to persist sessions.
   * Defaults to SqliteSessionStore at .skawld/sessions.db, constructed lazily on
   * the first session() call so tests that supply their own store never touch disk.
   */
  sessionStore?: SessionStore;
  /** Working directory for tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Additional system-prompt text appended after the default. */
  systemPrompt?: string;
  /** Override compaction. Defaults to the built-in strategy at 80% of context window. */
  compaction?: CompactionStrategy;
  /** Max retries for retryable provider errors. Default 5. */
  maxRetries?: number;
  /**
   * Max output tokens per turn. When omitted, the request does NOT carry an
   * Agent-level cap: OpenAI providers omit `max_tokens` from the wire (the
   * model's API default applies); the Anthropic provider falls back to 32768
   * because its API requires the field. Pass an explicit number to override
   * both behaviors.
   */
  maxOutputTokens?: number;
  /** Emit partial_assistant events with token deltas. Default false. */
  includePartialMessages?: boolean;
  /**
   * Optional hard cap on turns per run. Default: unbounded — a run continues
   * until the model stops calling tools (or the run is aborted/errors). Set a
   * positive integer to cap runaway loops; hitting the cap yields a
   * TurnLimitError result.
   */
  maxTurns?: number;
  /**
   * Prompt-cache TTL hint. Default "5m" (Anthropic's standard ephemeral cache).
   * Set to "1h" for long-idle sessions where gaps between turns may exceed 5 min;
   * costs 2x base on cache write but keeps the prefix warm for an hour.
   * Only affects providers with explicit cache control (Anthropic); OpenAI ignores.
   */
  cacheTtl?: "5m" | "1h";
  /**
   * Per-project config directory. Skills are loaded from
   * `<configDir>/skills/<name>/SKILL.md`. Defaults to `".skawld"` resolved
   * against `cwd`. Pass an absolute path to override.
   */
  configDir?: string;
  /**
   * Typed, programmatic interception points around tool calls, prompts, the stop
   * boundary, and compaction. Agent-level, like `canUseTool`. See
   * spec_docs/phase-02/14-hooks.html.
   */
  hooks?: Hooks;
}

/** Internal state accessible to the loop and scheduler (Phase 3+). */
export interface AgentInternal {
  provider: BaseProvider;
  model: ModelId;
  tools: ToolRegistry;
  permissionEngine: PermissionEngine;
  /** Returns (or lazily creates) the session store. */
  getStore: () => SessionStore;
  /** Close the store if it was ever allocated; no-op otherwise. */
  closeStore: () => Promise<void>;
  /** Connect configured MCP servers once (memoized). No-op when none configured. */
  connectMcp: () => Promise<void>;
  /** Disconnect MCP servers if connected; no-op otherwise. */
  closeMcp: () => Promise<void>;
  cwd: string;
  systemBlocks: SystemBlock[];
  maxRetries: number;
  /** Undefined means "no Agent-level cap" — the request omits the field and the
   * provider applies its own default (Anthropic falls back to 32768 since its
   * API requires `max_tokens`; OpenAI omits it from the wire). */
  maxOutputTokens: number | undefined;
  /** Max number of parallel-safe tool calls in flight at once in the scheduler.
   * Resolved once at Agent construction via getDefaultToolConcurrency() so
   * env-var changes during a process don't race per-turn. */
  toolConcurrency: number;
  includePartialMessages: boolean;
  maxTurns: number;
  compaction: CompactionStrategy | undefined;
  cacheTtl: "5m" | "1h" | undefined;
  /** Loaded skill set keyed by name. Populated lazily on first session(). */
  skills: Map<string, Skill>;
  /** Cached byte-stable `skill_listing` text. Undefined when no skills are loaded. */
  skillListingText: string | undefined;
  /** Connect skills + SkillTool lazily on first session(). Memoized. */
  connectSkills: () => Promise<void>;
  /** Registry of session internals (held weakly) so SkillTool can locate the active session. */
  sessions: Map<string, WeakRef<SessionInternal>>;
  /** Register a session's internals for lookup + automatic pruning on GC. */
  registerSession: (id: string, si: SessionInternal) => void;
  /** Subagent registry — disk-loaded agents + built-in default. Populated by connectSubagents. */
  subagentRegistry: AgentRegistry;
  /** Connect subagents + SubagentTool lazily on first session(). Memoized. */
  connectSubagents: () => Promise<void>;
  /** Per-parent-Session counter for "Agent #N" default-subagent display names. */
  subagentRunCounters: Map<string, number>;
  /** Hook orchestration — resolved once at construction; pure (zero I/O). */
  hookRunner: HookRunner;
}

const agentInternals = new WeakMap<Agent, AgentInternal>();

/** Package-private accessor used by loop / scheduler (Phase 3+). */
export function getAgentInternals(agent: Agent): AgentInternal {
  const internals = agentInternals.get(agent);
  if (!internals) throw new Error("Agent internals not found");
  return internals;
}

export class Agent {
  public readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    if (!opts.provider) throw new ConfigError("Agent requires a provider");
    if (!opts.model) throw new ConfigError("Agent requires a model");
    if (
      opts.maxRetries !== undefined &&
      (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0)
    ) {
      throw new ConfigError("Agent maxRetries must be a non-negative integer");
    }
    if (
      opts.maxTurns !== undefined &&
      (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1)
    ) {
      throw new ConfigError("Agent maxTurns must be an integer ≥ 1");
    }
    if (
      opts.maxOutputTokens !== undefined &&
      (!Number.isInteger(opts.maxOutputTokens) || opts.maxOutputTokens <= 0)
    ) {
      throw new ConfigError("Agent maxOutputTokens must be a positive integer");
    }

    this.opts = opts;

    // Construct the hook runner eagerly so invalid hook config throws a
    // ConfigError synchronously from the Agent constructor.
    const hookRunner = new HookRunner(opts.hooks ?? {});

    const cwd = opts.cwd ?? process.cwd();
    const tools = opts.tools ?? defaultTools();
    const permMode: PermissionMode = opts.permissions?.mode ?? "default";
    // Copy so connectSkills' auto-allow pushes land on our array, never the
    // caller's. The engine reads its `opts.rules` live, so pushes still reach it.
    const permRules = [...(opts.permissions?.rules ?? [])];

    const permissionEngine = new PermissionEngine({
      mode: permMode,
      rules: permRules,
      canUseTool: opts.permissions?.canUseTool,
      projectRoot: cwd,
    });

    const skawldVersion = SKAWLD_VERSION;

    // Rebuildable so the tool-name list can be refreshed after MCP tools register.
    const buildBlocks = (toolNames: string[]): SystemBlock[] =>
      buildSystemBlocks({
        userInstructions: opts.systemPrompt,
        cwd,
        os: { platform: process.platform, release: os.release(), arch: process.arch },
        shell: process.env.SHELL ?? "unknown",
        nodeVersion: process.version,
        skawldVersion,
        toolNames,
        permissionMode: permMode,
      });

    const systemBlocks = buildBlocks(tools.list().map(t => t.name).sort());

    // Lazy store: the SqliteSessionStore is only instantiated on the first
    // session() call. If the caller passed their own store, use it directly.
    let _store: SessionStore | undefined = opts.sessionStore;

    const getStore = (): SessionStore => {
      if (!_store) {
        _store = new SqliteSessionStore({ cwd });
      }
      return _store;
    };

    const closeStore = async (): Promise<void> => {
      // Only close if the store was actually allocated.
      await _store?.close?.();
    };

    // MCP servers connect lazily on the first session() call. The connect is
    // memoized so concurrent session() calls share one in-flight attempt.
    let _mcp: McpConnection | undefined;
    let _mcpConnect: Promise<void> | undefined;

    const connectMcp = (): Promise<void> => {
      if (!opts.mcpServers || Object.keys(opts.mcpServers).length === 0) return Promise.resolve();
      if (!_mcpConnect) {
        _mcpConnect = (async () => {
          _mcp = await connectMcpServers(opts.mcpServers!);
          for (const tool of _mcp.tools) tools.register(tool);
          // Refresh the system-prompt tool list to include the MCP tools.
          internal.systemBlocks = buildBlocks(tools.list().map(t => t.name).sort());
        })().catch((err) => {
          // Clear the memo so a caught connect failure can be retried on the
          // next session() call (connectMcpServers tears down fully on failure).
          _mcpConnect = undefined;
          throw err;
        });
      }
      return _mcpConnect;
    };

    const closeMcp = async (): Promise<void> => {
      await _mcp?.close();
    };

    const skills = new Map<string, Skill>();
    // Sessions are held weakly so a long-lived Agent doesn't retain every session
    // it ever created. When a Session (and its internals) is collected, the
    // registry prunes the map entry and the matching subagent counter.
    const sessions = new Map<string, WeakRef<SessionInternal>>();
    const sessionCleanup = new FinalizationRegistry<string>((sid) => {
      if (sessions.get(sid)?.deref() === undefined) {
        sessions.delete(sid);
        subagentRunCounters.delete(sid);
      }
    });
    const registerSession = (id: string, si: SessionInternal): void => {
      sessions.set(id, new WeakRef(si));
      sessionCleanup.register(si, id);
    };
    const configDir = opts.configDir
      ? path.resolve(cwd, opts.configDir)
      : path.resolve(cwd, ".skawld");
    let _skillsConnect: Promise<void> | undefined;
    const connectSkills = (): Promise<void> => {
      if (!_skillsConnect) {
        _skillsConnect = (async () => {
          const builtinNames = new Set(tools.list().map(t => t.name));
          const { skills: loaded } = await loadSkillsFromDir({
            configDir,
            builtinToolNames: builtinNames,
          });
          for (const s of loaded) skills.set(s.name, s);

          if (skills.size > 0) {
            // Register the Skill tool — has access to the live skills map +
            // the per-session registry built by Agent.session().
            const skillTool = new SkillTool({
              skills,
              getSessionInternal: (sid) => sessions.get(sid)?.deref(),
              getSessionModel: () => internal.model,
            });
            tools.register(skillTool);

            // Auto-allow rules for informational skills (no allowed_tools, no
            // model override). User-provided rules still take precedence by
            // being earlier in the list — we APPEND.
            for (const s of loaded) {
              if (!s.frontmatter.allowedTools && !s.frontmatter.model) {
                permRules.push({ kind: "tool", tool: "Skill", arg: s.name, decision: "allow" });
              }
            }

            // Refresh system-prompt tool list to include Skill.
            internal.systemBlocks = buildBlocks(tools.list().map(t => t.name).sort());

            // Cache the byte-stable listing for the prompt-cache front block.
            internal.skillListingText = buildSkillListing({
              skills: loaded,
              contextWindowTokens: internal.provider.contextWindow(internal.model),
            }) || undefined;
          }
        })().catch((err) => {
          _skillsConnect = undefined;
          throw err;
        });
      }
      return _skillsConnect;
    };

    // Memoized like connectSkills/connectMcp. The Subagent tool registers
    // unconditionally on first session() since the built-in default is always
    // available, even when no disk agents are present.
    let _subagentsConnect: Promise<void> | undefined;
    const subagentRunCounters = new Map<string, number>();
    const connectSubagents = (): Promise<void> => {
      if (!_subagentsConnect) {
        _subagentsConnect = (async () => {
          const { agents: diskAgents } = await loadAgentsFromDir({ configDir });
          internal.subagentRegistry = buildAgentRegistry(diskAgents);
          const subagentTool = new SubagentTool({
            registry: internal.subagentRegistry,
            getSessionInternal: (sid) => sessions.get(sid)?.deref(),
            nextDefaultDisplayName: (sid) => {
              const cur = subagentRunCounters.get(sid) ?? 0;
              subagentRunCounters.set(sid, cur + 1);
              return `Agent #${cur + 1}`;
            },
          });
          tools.register(subagentTool);
          // Refresh system-prompt tool list to include Subagent.
          internal.systemBlocks = buildBlocks(tools.list().map(t => t.name).sort());
        })().catch((err) => {
          _subagentsConnect = undefined;
          throw err;
        });
      }
      return _subagentsConnect;
    };

    const internal: AgentInternal = {
      provider: opts.provider,
      model: opts.model,
      tools,
      permissionEngine,
      getStore,
      closeStore,
      connectMcp,
      closeMcp,
      cwd,
      systemBlocks,
      maxRetries: opts.maxRetries ?? 5,
      maxOutputTokens: opts.maxOutputTokens,
      toolConcurrency: getDefaultToolConcurrency(),
      includePartialMessages: opts.includePartialMessages ?? false,
      maxTurns: opts.maxTurns ?? Infinity,
      compaction: opts.compaction ?? defaultCompaction,
      cacheTtl: opts.cacheTtl,
      skills,
      skillListingText: undefined,
      connectSkills,
      sessions,
      registerSession,
      // Initialize with built-in-default-only; connectSubagents rebuilds after disk load.
      subagentRegistry: buildAgentRegistry([]),
      connectSubagents,
      subagentRunCounters,
      hookRunner,
    };

    agentInternals.set(this, internal);
  }

  /** Create or resume a session. */
  async session(input?: { id?: string; meta?: Record<string, unknown> }): Promise<Session> {
    const internal = getAgentInternals(this);
    const { getStore, connectMcp, connectSkills, connectSubagents } = internal;
    // Ensure MCP servers are connected (and their tools registered) before the
    // session runs. Throws if any configured server fails to connect.
    await connectMcp();
    // Load skills (and register SkillTool) lazily on first session().
    await connectSkills();
    // Load subagents (and register SubagentTool) lazily on first session().
    await connectSubagents();
    const store = getStore();

    const record = await store.create({ id: input?.id, meta: input?.meta });

    // Resume: load persisted messages. New session: start empty.
    const storedMessages = input?.id ? await store.loadMessages(input.id) : [];
    const providerView = storedMessages.map(sm => sm.message);

    const session = new Session({ record, providerView, agent: this, store });
    // Register session for SkillTool/Subagent lookup. Held weakly and pruned when
    // the Session is garbage-collected, so a long-lived Agent stays bounded.
    internal.registerSession(record.id, getSessionInternals(session));
    return session;
  }

  /**
   * Release resources. Closes the session store only if it was ever allocated,
   * so tests that never call session() do not inadvertently create a SQLite file.
   */
  async close(): Promise<void> {
    const internal = agentInternals.get(this);
    await internal?.closeMcp();
    await internal?.closeStore();
  }
}
