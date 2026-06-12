/**
 * Hooks: typed, programmatic interception points the engine calls at five named
 * moments. See spec_docs/phase-02/14-hooks.html.
 *
 * The `HookRunner` is pure orchestration — zero I/O. It resolves matchers,
 * enforces per-hook timeouts, applies each event's failure policy, and collects
 * `HookErrorEvent`s for the call site to surface (the loop yields them, the
 * scheduler emits them). One runner per Agent, stored on AgentInternal.
 */

import { ConfigError } from "./errors.js";
import type { StopReason, TextBlock, ImageBlock } from "./types.js";
import type { HookErrorEvent } from "./events.js";
import type { Tool } from "../tools/base.js";

// ---------------------------------------------------------------------------
// HookContext — second argument to every hook
// ---------------------------------------------------------------------------

export interface HookContext {
  session_id: string;
  run_id: string;
  cwd: string;
  /** The run's merged abort signal. Long-running hooks must respect it. */
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

export interface PreToolUseHookInput {
  tool_name: string;
  tool_use_id: string;
  /** Validated input — after tool.validate(), including any rewrite by earlier hooks. */
  input: Record<string, unknown>;
  /** tool.summarize(input) for the current input. */
  summary: string;
}

export type PreToolUseHookOutcome =
  | void
  | { action: "continue"; updatedInput?: Record<string, unknown> }
  | { action: "allow"; updatedInput?: Record<string, unknown> }
  | { action: "deny"; reason: string }
  | { action: "ask" };

export type PreToolUseHook = (
  input: PreToolUseHookInput,
  ctx: HookContext,
) => PreToolUseHookOutcome | Promise<PreToolUseHookOutcome>;

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

export interface PostToolUseHookInput {
  tool_name: string;
  tool_use_id: string;
  /** The effective input the tool ran with (post-rewrite). */
  input: Record<string, unknown>;
  /** ToolResult content — string or text/image block array, exactly as returned. */
  content: string | Array<TextBlock | ImageBlock>;
  is_error: boolean;
  duration_ms: number;
}

export type PostToolUseHookOutcome = void | { additionalContext?: string };

export type PostToolUseHook = (
  input: PostToolUseHookInput,
  ctx: HookContext,
) => PostToolUseHookOutcome | Promise<PostToolUseHookOutcome>;

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

export interface UserPromptSubmitHookInput {
  prompt: string;
  source: "run" | "steer";
}

export type UserPromptSubmitHookOutcome =
  | void
  | { action: "block"; reason: string }
  | { action: "continue"; additionalContext?: string };

export type UserPromptSubmitHook = (
  input: UserPromptSubmitHookInput,
  ctx: HookContext,
) => UserPromptSubmitHookOutcome | Promise<UserPromptSubmitHookOutcome>;

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export interface StopHookInput {
  /** The stop reason that ended the turn — "end_turn", "max_tokens", "refusal", ... */
  stop_reason: StopReason;
  final_text?: string;
  /** True when this run already continued at least once because a Stop hook blocked. */
  stop_hook_active: boolean;
}

export type StopHookOutcome = void | { action: "block"; reason: string };

export type StopHook = (
  input: StopHookInput,
  ctx: HookContext,
) => StopHookOutcome | Promise<StopHookOutcome>;

// ---------------------------------------------------------------------------
// PreCompact (observational)
// ---------------------------------------------------------------------------

export interface PreCompactHookInput {
  /** "threshold" = the 80%-of-context-window check; "forced" = ContextLengthError recovery. */
  trigger: "threshold" | "forced";
  messages_before: number;
  /** Projected token usage that triggered compaction (same basis as CompactionEvent.tokens_before). */
  tokens_before: number;
}

export type PreCompactHook = (
  input: PreCompactHookInput,
  ctx: HookContext,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface HookRegistration<H> {
  /**
   * Tool-name matcher. Only meaningful for preToolUse / postToolUse; ignored on
   * the other events. Exact name ("Bash"), or a glob where `*` matches any run
   * of characters ("mcp__github__*", "Task*", "*"). Omitted = matches every
   * tool. Case-sensitive.
   */
  matcher?: string;
  /** Per-hook timeout in milliseconds. Default 60_000. */
  timeoutMs?: number;
  hook: H;
}

export interface Hooks {
  preToolUse?: Array<HookRegistration<PreToolUseHook>>;
  postToolUse?: Array<HookRegistration<PostToolUseHook>>;
  userPromptSubmit?: Array<HookRegistration<UserPromptSubmitHook>>;
  stop?: Array<HookRegistration<StopHook>>;
  preCompact?: Array<HookRegistration<PreCompactHook>>;
}

// ---------------------------------------------------------------------------
// Internal resolution shapes — consumed by the scheduler / loop / compaction.
// Not exported from the public SDK surface.
// ---------------------------------------------------------------------------

export interface PreToolUseResolution {
  /** Final composed outcome: deny > ask > allow > continue. */
  kind: "continue" | "allow" | "ask" | "deny";
  /** The final (possibly rewritten + re-validated) input. */
  input: Record<string, unknown>;
  /** Summary recomputed for the final input. */
  summary: string;
  /** Set when kind === "deny". */
  reason?: string;
  errors: HookErrorEvent[];
}

export interface PostToolUseResolution {
  /** additionalContext strings in registration order. */
  additionalContext: string[];
  errors: HookErrorEvent[];
}

export interface UserPromptSubmitResolution {
  blocked?: { reason: string };
  additionalContext: string[];
  errors: HookErrorEvent[];
}

export interface StopResolution {
  blocked?: { reason: string };
  errors: HookErrorEvent[];
}

export interface PreCompactResolution {
  errors: HookErrorEvent[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// HookRunner
// ---------------------------------------------------------------------------

export class HookRunner {
  private readonly hooks: Hooks;

  constructor(hooks: Hooks) {
    validateHookConfig(hooks);
    this.hooks = hooks;
  }

  get hasPreToolUse(): boolean { return (this.hooks.preToolUse?.length ?? 0) > 0; }
  get hasPostToolUse(): boolean { return (this.hooks.postToolUse?.length ?? 0) > 0; }
  get hasUserPromptSubmit(): boolean { return (this.hooks.userPromptSubmit?.length ?? 0) > 0; }
  get hasStop(): boolean { return (this.hooks.stop?.length ?? 0) > 0; }
  get hasPreCompact(): boolean { return (this.hooks.preCompact?.length ?? 0) > 0; }

  /**
   * Resolve all matching PreToolUse hooks for one call, sequentially in
   * registration order. deny short-circuits; allow/ask are recorded but a later
   * hook can still deny. Each hook sees the input as rewritten by earlier hooks;
   * a rewrite that fails re-validation converts the resolution to deny.
   * Throw/timeout fails CLOSED (deny).
   */
  async runPreToolUse(args: {
    tool: Tool<any>;
    toolUseId: string;
    input: Record<string, unknown>;
    summary: string;
    ctx: HookContext;
  }): Promise<PreToolUseResolution> {
    const regs = matching(this.hooks.preToolUse, args.tool.name);
    const errors: HookErrorEvent[] = [];
    let input = args.input;
    let summary = args.summary;
    let asked = false;
    let allowed = false;

    for (const reg of regs) {
      const r = await invoke(reg, "PreToolUse", args.toolUseId, errors, () =>
        reg.hook({ tool_name: args.tool.name, tool_use_id: args.toolUseId, input, summary }, args.ctx),
      );
      if (!r.ok) {
        // A guardrail that crashed must not wave calls through.
        return { kind: "deny", input, summary, reason: `Hook failed: ${r.message}`, errors };
      }
      const outcome = r.value;
      if (!outcome) continue;
      if (outcome.action === "deny") {
        return { kind: "deny", input, summary, reason: outcome.reason, errors };
      }
      if (outcome.action === "ask") {
        asked = true;
        continue;
      }
      // "continue" | "allow" — both may carry an updatedInput rewrite.
      if (outcome.updatedInput !== undefined) {
        try {
          input = args.tool.validate(outcome.updatedInput) as Record<string, unknown>;
          summary = safeSummarize(args.tool, input);
        } catch (err) {
          return { kind: "deny", input, summary, reason: `invalid hook rewrite: ${message(err)}`, errors };
        }
      }
      if (outcome.action === "allow") allowed = true;
    }

    const kind = asked ? "ask" : allowed ? "allow" : "continue";
    return { kind, input, summary, errors };
  }

  /** PostToolUse for one executed call. Fail-open; collects additionalContext strings. */
  async runPostToolUse(args: {
    tool: Tool<any>;
    toolUseId: string;
    input: Record<string, unknown>;
    content: string | Array<TextBlock | ImageBlock>;
    isError: boolean;
    durationMs: number;
    ctx: HookContext;
  }): Promise<PostToolUseResolution> {
    const regs = matching(this.hooks.postToolUse, args.tool.name);
    const errors: HookErrorEvent[] = [];
    const additionalContext: string[] = [];
    for (const reg of regs) {
      const r = await invoke(reg, "PostToolUse", args.toolUseId, errors, () =>
        reg.hook({
          tool_name: args.tool.name,
          tool_use_id: args.toolUseId,
          input: args.input,
          content: args.content,
          is_error: args.isError,
          duration_ms: args.durationMs,
        }, args.ctx),
      );
      if (!r.ok) continue; // fail open
      const extra = r.value?.additionalContext;
      if (typeof extra === "string" && extra.length > 0) additionalContext.push(extra);
    }
    return { additionalContext, errors };
  }

  /** UserPromptSubmit. First block short-circuits; additionalContext accumulates. Fail-open. */
  async runUserPromptSubmit(args: {
    prompt: string;
    source: "run" | "steer";
    ctx: HookContext;
  }): Promise<UserPromptSubmitResolution> {
    const regs = this.hooks.userPromptSubmit ?? [];
    const errors: HookErrorEvent[] = [];
    const additionalContext: string[] = [];
    for (const reg of regs) {
      const r = await invoke(reg, "UserPromptSubmit", undefined, errors, () =>
        reg.hook({ prompt: args.prompt, source: args.source }, args.ctx),
      );
      if (!r.ok) continue; // fail open
      const outcome = r.value;
      if (!outcome) continue;
      if (outcome.action === "block") {
        return { blocked: { reason: outcome.reason }, additionalContext, errors };
      }
      if (
        outcome.action === "continue" &&
        typeof outcome.additionalContext === "string" &&
        outcome.additionalContext.length > 0
      ) {
        additionalContext.push(outcome.additionalContext);
      }
    }
    return { additionalContext, errors };
  }

  /** Stop. First block wins. Fail-open. */
  async runStop(args: {
    stopReason: StopReason;
    finalText?: string;
    stopHookActive: boolean;
    ctx: HookContext;
  }): Promise<StopResolution> {
    const regs = this.hooks.stop ?? [];
    const errors: HookErrorEvent[] = [];
    for (const reg of regs) {
      const r = await invoke(reg, "Stop", undefined, errors, () =>
        reg.hook({
          stop_reason: args.stopReason,
          ...(args.finalText !== undefined && { final_text: args.finalText }),
          stop_hook_active: args.stopHookActive,
        }, args.ctx),
      );
      if (!r.ok) continue; // fail open
      const outcome = r.value;
      if (outcome && outcome.action === "block") {
        return { blocked: { reason: outcome.reason }, errors };
      }
    }
    return { errors };
  }

  /** PreCompact. Observational + fail-open: only HookErrorEvents are collected. */
  async runPreCompact(args: {
    trigger: "threshold" | "forced";
    messagesBefore: number;
    tokensBefore: number;
    ctx: HookContext;
  }): Promise<PreCompactResolution> {
    const regs = this.hooks.preCompact ?? [];
    const errors: HookErrorEvent[] = [];
    for (const reg of regs) {
      await invoke(reg, "PreCompact", undefined, errors, () =>
        reg.hook({
          trigger: args.trigger,
          messages_before: args.messagesBefore,
          tokens_before: args.tokensBefore,
        }, args.ctx),
      );
    }
    return { errors };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class HookTimeoutError extends Error {}

type InvokeResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Run one hook with timeout enforcement; on throw/timeout push a HookErrorEvent. */
async function invoke<T>(
  reg: { timeoutMs?: number },
  hookEvent: HookErrorEvent["hook_event"],
  toolUseId: string | undefined,
  errors: HookErrorEvent[],
  call: () => T | Promise<T>,
): Promise<InvokeResult<T>> {
  const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const value = await withTimeout(Promise.resolve().then(call), timeoutMs);
    return { ok: true, value };
  } catch (err) {
    const msg = err instanceof HookTimeoutError ? `Hook timed out after ${timeoutMs}ms` : message(err);
    errors.push({
      type: "hook_error",
      hook_event: hookEvent,
      message: msg,
      ...(toolUseId !== undefined && { tool_use_id: toolUseId }),
    });
    return { ok: false, message: msg };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookTimeoutError()), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeSummarize(tool: Tool<any>, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input);
  } catch {
    return `${tool.name}(...)`;
  }
}

/** Filter registrations whose matcher (glob over tool names) matches `toolName`. */
function matching<H>(
  regs: Array<HookRegistration<H>> | undefined,
  toolName: string,
): Array<HookRegistration<H>> {
  if (!regs) return [];
  return regs.filter((r) => r.matcher === undefined || matchesGlob(r.matcher, toolName));
}

/** `*` matches any run of characters; all other characters are literal. Case-sensitive. */
function matchesGlob(pattern: string, name: string): boolean {
  const re = "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(re).test(name);
}

function validateHookConfig(hooks: Hooks): void {
  const keys: Array<keyof Hooks> = [
    "preToolUse", "postToolUse", "userPromptSubmit", "stop", "preCompact",
  ];
  for (const key of keys) {
    const regs = hooks[key];
    if (regs === undefined) continue;
    if (!Array.isArray(regs)) throw new ConfigError(`hooks.${key} must be an array`);
    for (const reg of regs) {
      if (reg == null || typeof (reg as { hook?: unknown }).hook !== "function") {
        throw new ConfigError(`hooks.${key} entries must have a 'hook' function`);
      }
      if (
        reg.timeoutMs !== undefined &&
        (typeof reg.timeoutMs !== "number" || !Number.isFinite(reg.timeoutMs) || reg.timeoutMs <= 0)
      ) {
        throw new ConfigError(`hooks.${key} timeoutMs must be a positive number`);
      }
      if (reg.matcher !== undefined && typeof reg.matcher !== "string") {
        throw new ConfigError(`hooks.${key} matcher must be a string`);
      }
    }
  }
}
