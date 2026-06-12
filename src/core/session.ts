/** Session class. See docs/05-agent-loop.html#session. */

import { AbortError, ConfigError } from "./errors.js";
import { FileReadTracker } from "../tools/file-tracker.js";
import { runLoop } from "./loop.js";
import type { Agent } from "./agent.js";
import type { InvokedSkillRecord, Message, SkillOverlay, Usage } from "./types.js";
import type { SessionRecord, SessionStore } from "../sessions/store.js";
import type { CompactionEvent, Event, HookErrorEvent } from "./events.js";
import type { EffortLevel, SystemBlock, ThinkingConfig } from "../providers/base.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface RunOptions {
  /** Caller-provided signal; chained with the session's internal one. */
  signal?: AbortSignal;
  /** Per-run override of max output tokens. */
  maxOutputTokens?: number;
  /** Per-run override of the temperature. */
  temperature?: number;
  /** Attach images to the user prompt. */
  images?: Array<{ data: string; mediaType: string } | { url: string }>;
  /** Per-run extended-thinking config; overrides the provider default. Anthropic-only. */
  thinking?: ThinkingConfig;
  /** Per-run effort hint; overrides the provider default. Anthropic-only. */
  effort?: EffortLevel;
}

/** Internal state accessible to the loop and scheduler (Phase 3+). */
export interface SessionInternal {
  id: string;
  agent: Agent;
  store: SessionStore;
  /** In-memory message history sent to the provider. May diverge from fullHistory after compaction. */
  providerView: Message[];
  /** Full message history — always all messages, including pre-compaction ones. */
  fullHistory: Message[];
  fileReadTracker: FileReadTracker;
  lastUsage: Usage | undefined;
  compactionRetryUsedThisTurn: boolean;
  /** Skills invoked this session, in invocation order. Re-emitted after compaction and on resume. */
  invokedSkills: InvokedSkillRecord[];
  /** True once SkillsLoadedEvent has been emitted for this session. */
  skillsLoadedEmitted: boolean;
  /** Stashed by SkillTool; consumed by the loop before the next provider.send. */
  pendingSkillOverlay?: SkillOverlay;
  /**
   * Additive allow set in effect for the CURRENT assistant turn (between the
   * loop applying overlay and the end of tool execution). Cleared in finally.
   */
  currentTurnAllowedTools?: string[];
  /**
   * Per-run abort controller. Created fresh at the start of each run in Session.run()
   * and cleared in the cleanup path. Aborting while idle is a no-op for the next run
   * because a fresh controller is created before runLoop reads it.
   */
  internalController: AbortController;
  /** Set by runLoop when it starts; null when idle. */
  activeRunId: string | null;
  /**
   * FIFO of user messages queued via Session.steer() for injection into the
   * active run. Drained by the loop at turn boundaries; entries still pending
   * when the run ends are rejected with AbortError (see rejectSteeringQueue).
   */
  steeringQueue: Array<{
    prompt: string;
    images?: RunOptions["images"];
    resolve: () => void;
    reject: (err: unknown) => void;
  }>;
  /**
   * Set by Session.interrupt(); reset at the start of each run (same pattern as
   * internalController) so an interrupt against an idle session never poisons
   * the next run. Checked at the top of each turn by the loop.
   */
  interruptRequested: boolean;
  /**
   * Optional per-session tool registry override. When set, the loop and the
   * scheduler resolve tools through this registry instead of `agent.tools`.
   * Used by the subagent runner to give the child Session a filtered view of
   * the parent's tools. Default: undefined (= use the agent's registry).
   */
  toolsOverride?: ToolRegistry;
  /**
   * Optional per-session system blocks override. When set, the provider request
   * is built with these blocks instead of the agent's. Used by the subagent
   * runner so the child's system prompt is the agent definition's body.
   * Default: undefined (= use the agent's blocks).
   */
  systemBlocksOverride?: SystemBlock[];
  /**
   * Current run's thinking config — captured at Session.run() start so the
   * subagent runner can forward it to child runs (cost knobs propagate through
   * the spawn tree). Stale-after-run; only read while a run is active.
   */
  currentThinking?: ThinkingConfig;
  /**
   * Current run's effort hint — captured at Session.run() start (same reason
   * as currentThinking). Stale-after-run; only read while a run is active.
   */
  currentEffort?: EffortLevel;
  /** Append messages to both providerView, fullHistory, and the store. */
  append(messages: Message[]): Promise<void>;
  /**
   * Stashed compaction info for the loop to read via buildCompactionEvent.
   * Set by runCompactionImpl; read once by the loop to yield CompactionEvent.
   */
  lastCompactionInfo?: CompactionEvent;
  /**
   * HookErrorEvents produced by the PreCompact hook during the most recent
   * compaction attempt. Set by runCompactionImpl, drained + cleared by the loop
   * after maybeCompact / runForcedCompaction so they surface even on no-op
   * compactions. Undefined when no compaction ran this turn.
   */
  lastCompactionHookErrors?: HookErrorEvent[];
  /** Record that compaction retry was used this turn. */
  markCompactionUsed(): void;
}

const sessionInternals = new WeakMap<Session, SessionInternal>();

/** Package-private accessor used by loop / scheduler (Phase 3+). */
export function getSessionInternals(session: Session): SessionInternal {
  const internals = sessionInternals.get(session);
  if (!internals) throw new Error("Session internals not found");
  return internals;
}

/**
 * Reject every still-pending steering promise with AbortError and empty the
 * queue (in place, preserving array identity). Called by the loop's interrupt
 * checkpoint and by run cleanup so an ended/abandoned run never leaks unsettled
 * steer() promises. Idempotent: a no-op when the queue is already empty.
 */
export function rejectSteeringQueue(internal: SessionInternal): void {
  const pending = internal.steeringQueue.splice(0);
  for (const entry of pending) {
    entry.reject(new AbortError("Run ended before steering message was injected"));
  }
}

interface SessionConstructorArgs {
  record: SessionRecord;
  providerView: Message[];
  agent: Agent;
  store: SessionStore;
}

// Module-level registry: a per-call registry is unreferenced after
// makeCleanupIterator returns and may be collected before its callback runs,
// making the abandonment safety net unreliable. One module-scoped registry is
// always reachable. With C2's rejection-path cleanup this is only a last resort.
const cleanupRegistry = new FinalizationRegistry<() => void>((fn) => fn());

/**
 * Wraps an AsyncGenerator with explicit cleanup on:
 *   - Normal completion (done === true via next())
 *   - A next() rejection (store failure before the loop's try — see C2)
 *   - Consumer calling return() (for-await break, explicit .return())
 *   - Consumer calling throw()
 *   - GC via FinalizationRegistry (handles pure abandonment without calling return())
 *
 * This prevents _activeRunId from leaking when the consumer abandons the iterator.
 */
function makeCleanupIterator<T>(
  gen: AsyncGenerator<T>,
  cleanup: () => void,
): AsyncGenerator<T> {
  let cleaned = false;
  function runCleanup() {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
  }

  const iter: AsyncGenerator<T> = {
    async next(...args: [] | [undefined]): Promise<IteratorResult<T>> {
      let r: IteratorResult<T>;
      try {
        r = await gen.next(...args);
      } catch (err) {
        // A rejection (not a normal `done`) skips the done-branch below; run
        // cleanup here so activeRunId is released, then rethrow.
        runCleanup();
        throw err;
      }
      if (r.done) runCleanup();
      return r;
    },
    async return(value): Promise<IteratorResult<T>> {
      runCleanup();
      return gen.return(value);
    },
    async throw(err): Promise<IteratorResult<T>> {
      runCleanup();
      return gen.throw(err);
    },
    [Symbol.asyncIterator](): AsyncGenerator<T> {
      return this;
    },
  };

  cleanupRegistry.register(iter, runCleanup);
  return iter;
}

export class Session {
  public readonly id: string;
  public readonly createdAt: Date;
  public readonly meta: Record<string, unknown>;

  constructor({ record, providerView, agent, store }: SessionConstructorArgs) {
    this.id = record.id;
    this.createdAt = new Date(record.created_at);
    this.meta = record.meta;

    const fullHistory = providerView.slice();

    const internal: SessionInternal = {
      id: record.id,
      agent,
      store,
      providerView,
      fullHistory,
      fileReadTracker: new FileReadTracker(),
      lastUsage: undefined,
      compactionRetryUsedThisTurn: false,
      invokedSkills: (record.invokedSkills ?? []).slice(),
      skillsLoadedEmitted: false,
      // Placeholder controller for the idle state. Replaced with a fresh one at
      // the start of each run so aborting between runs never pre-poisons the next.
      internalController: new AbortController(),
      activeRunId: null,
      steeringQueue: [],
      interruptRequested: false,
      async append(messages: Message[]): Promise<void> {
        await store.appendMessages(record.id, messages);
        for (const m of messages) {
          providerView.push(m);
          fullHistory.push(m);
        }
      },
      markCompactionUsed(): void {
        internal.compactionRetryUsedThisTurn = true;
      },
    };

    sessionInternals.set(this, internal);
  }

  /** Total number of messages the provider sees (NOT fullHistory). */
  get messageCount(): number {
    return sessionInternals.get(this)!.providerView.length;
  }

  /**
   * Run the agent with a new user prompt. Returns an async iterator of Event.
   * Throws ConfigError synchronously if a run is already active.
   */
  run(prompt: string, opts: RunOptions = {}): AsyncIterable<Event> {
    const internal = sessionInternals.get(this)!;

    if (internal.activeRunId !== null) {
      throw new ConfigError("Session already has an active run");
    }

    // Fresh controller per run — ensures that a prior abort() or completion
    // never pre-poisons subsequent runs.
    internal.internalController = new AbortController();
    // Same reasoning for the interrupt flag: a stale interrupt() from a prior
    // run must not poison this one.
    internal.interruptRequested = false;

    // Mark as pending synchronously; runLoop will replace with actual runId.
    internal.activeRunId = "pending";

    // Capture cost knobs so the subagent runner can forward them down the tree
    // (a subagent spawned mid-turn inherits the parent's thinking/effort).
    internal.currentThinking = opts.thinking;
    internal.currentEffort = opts.effort;

    const gen = runLoop(this, prompt, opts);
    return makeCleanupIterator(gen, () => {
      internal.activeRunId = null;
      internal.currentThinking = undefined;
      internal.currentEffort = undefined;
      // Reject any steering messages still queued when the run ends or the
      // iterator is abandoned, so steer() promises never leak unsettled.
      rejectSteeringQueue(internal);
    });
  }

  /**
   * Cancel the currently running iteration. Idempotent.
   * The next event yielded will be a ResultEvent with subtype "aborted".
   * Calling abort() while no run is active is a no-op — it aborts the idle
   * placeholder controller, which is replaced at the start of the next run.
   */
  abort(reason?: unknown): void {
    sessionInternals.get(this)!.internalController.abort(reason);
  }

  /**
   * Queue a user message for injection into the active run, drained at the next
   * turn boundary as a real persisted user message. Multiple calls queue FIFO.
   *
   * Throws ConfigError synchronously when no run is active. The returned promise
   * resolves once the message has been appended and its UserEvent emitted; it
   * rejects with AbortError if the run ends (abort / interrupt / error / turn
   * limit) before injection, or with HookError if a UserPromptSubmit hook blocks
   * this specific message. Rejections never crash the run.
   */
  steer(prompt: string, opts: { images?: RunOptions["images"] } = {}): Promise<void> {
    const internal = sessionInternals.get(this)!;
    if (internal.activeRunId === null) {
      throw new ConfigError("No active run to steer");
    }
    return new Promise<void>((resolve, reject) => {
      internal.steeringQueue.push({ prompt, images: opts.images, resolve, reject });
    });
  }

  /**
   * Request a graceful stop of the active run. Idempotent; a no-op when idle.
   * The current turn and its tool calls complete and persist; the run then ends
   * with ResultEvent subtype "interrupted" instead of starting another model
   * turn. Does not touch an in-flight stream — abort() remains the only
   * immediate mechanism.
   */
  interrupt(): void {
    sessionInternals.get(this)!.interruptRequested = true;
  }

  /** Update metadata in the store (shallow merge). */
  async updateMeta(patch: Record<string, unknown>): Promise<void> {
    const internal = sessionInternals.get(this)!;
    const updated = await internal.store.updateMeta(this.id, patch);
    // Merge the patch into the in-memory meta.
    Object.assign(this.meta, updated.meta);
  }
}
