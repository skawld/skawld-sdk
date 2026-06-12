/** Parallel tool execution scheduler. See docs/05-agent-loop.html#scheduler. */

import { AbortError } from "./errors.js";
import { throwIfAborted } from "./abort.js";
import { ToolEventQueue } from "./tool-event-queue.js";
import { mergeAsyncGenerators } from "./merge-generators.js";
import { wrapInSystemReminder } from "../skills/system-reminder.js";
import type { Event } from "./events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { Tool, ToolResult } from "../tools/base.js";
import type { PermissionDecision } from "../permissions/engine.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";
import type { HookContext } from "./hooks.js";

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface ResolvedCall {
  id: string;
  block: ToolUseBlock;
  tool: Tool<any> | null;
  input: Record<string, unknown>;
  summary: string;
  isImmediateError: boolean;
  immediateErrorReason?: string;
}

interface ExecResult {
  content: ToolResult["content"];
  is_error?: boolean;
  duration_ms: number;
  summary: string;
}

/**
 * The input a tool is actually invoked with: an allowed permission decision may
 * rewrite the input via updatedInput, which then becomes the canonical input
 * reported in tool_call_start (per docs/03-permissions.html#input-rewriting).
 */
function effectiveInput(
  call: ResolvedCall,
  decision: PermissionDecision,
): Record<string, unknown> {
  return decision.decision === "allow" && decision.updatedInput
    ? decision.updatedInput
    : call.input;
}

/** Display name for events: the resolved tool's name, or the raw block name for unknown tools. */
function callToolName(call: ResolvedCall): string {
  return call.tool?.name ?? call.block.name;
}

/** Build the HookContext shared by PreToolUse / PostToolUse hooks. */
function hookContextOf(ai: AgentInternal, si: SessionInternal, signal: AbortSignal): HookContext {
  return { session_id: si.id, run_id: si.activeRunId ?? "unknown", cwd: ai.cwd, signal };
}

/**
 * Append PostToolUse additionalContext strings to a tool_result's content, each
 * wrapped in <system-reminder>. String content gets "\n\n"-joined; block-array
 * content gets an extra TextBlock per string.
 */
function appendAdditionalContext(content: ToolResult["content"], extras: string[]): ToolResult["content"] {
  if (extras.length === 0) return content;
  const wrapped = extras.map((s) => wrapInSystemReminder(s));
  if (typeof content === "string") {
    return content + "\n\n" + wrapped.join("\n\n");
  }
  return [...content, ...wrapped.map((text) => ({ type: "text" as const, text }))];
}

/**
 * Returns the resolved skill name for a SkillTool call (with leading `/` stripped),
 * or undefined when this call is not a Skill invocation.
 */
function skillNameFromCall(call: ResolvedCall): string | undefined {
  if (call.isImmediateError) return undefined;
  if (call.tool?.name !== "Skill") return undefined;
  const raw = call.input.skill;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

// ---------------------------------------------------------------------------
// resolveCall
// ---------------------------------------------------------------------------

function resolveCall(block: ToolUseBlock, tools: ToolRegistry): ResolvedCall {
  // 1. Invalid JSON from stream assembly
  if (block.input.__invalidJson === true) {
    const raw = typeof block.input.raw === "string" ? block.input.raw : String(block.input.raw ?? "");
    return {
      id: block.id,
      block,
      tool: null,
      input: block.input,
      summary: `${block.name}(invalid JSON)`,
      isImmediateError: true,
      immediateErrorReason: `Tool input was not valid JSON: ${raw}`,
    };
  }

  // 2. Unknown tool
  const tool = tools.get(block.name) ?? null;
  if (tool === null) {
    return {
      id: block.id,
      block,
      tool: null,
      input: block.input,
      summary: `${block.name}(unknown)`,
      isImmediateError: true,
      immediateErrorReason: `Tool '${block.name}' is not registered`,
    };
  }

  // 3. Validate input
  let validated: Record<string, unknown>;
  try {
    validated = tool.validate(block.input) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: block.id,
      block,
      tool,
      input: block.input,
      summary: `${block.name}(invalid input)`,
      isImmediateError: true,
      immediateErrorReason: msg,
    };
  }

  // 4. Build summary from validated input
  let summary: string;
  try {
    summary = tool.summarize(validated);
  } catch {
    summary = `${block.name}(...)`;
  }

  return {
    id: block.id,
    block,
    tool,
    input: validated,
    summary,
    isImmediateError: false,
  };
}

// ---------------------------------------------------------------------------
// safeExecute
// ---------------------------------------------------------------------------

async function safeExecute(
  call: ResolvedCall,
  decision: PermissionDecision,
  ai: AgentInternal,
  si: SessionInternal,
  signal: AbortSignal,
  emit?: (event: Event) => void,
): Promise<ExecResult> {
  const t0 = Date.now();

  if (call.isImmediateError) {
    return {
      content: call.immediateErrorReason!,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }

  if (decision.decision === "deny") {
    return {
      content: `Tool call denied: ${decision.reason}`,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }

  try {
    const ctx = {
      cwd: ai.cwd,
      signal,
      fileReadTracker: si.fileReadTracker,
      sessionId: si.id,
      runId: si.activeRunId ?? "unknown",
      toolUseId: call.id,
      sessionStore: ai.getStore(),
      ...(emit !== undefined && { emit }),
    };
    const result = await call.tool!.execute(effectiveInput(call, decision), ctx);
    return {
      content: result.content,
      is_error: result.is_error,
      duration_ms: Date.now() - t0,
      summary: result.summary,
    };
  } catch (err) {
    if (err instanceof AbortError) throw err;
    return {
      content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }
}

// ---------------------------------------------------------------------------
// toToolResultBlock
// ---------------------------------------------------------------------------

function toToolResultBlock(call: ResolvedCall, result: ExecResult): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: result.content,
    is_error: result.is_error,
  };
}

// ---------------------------------------------------------------------------
// reorderByIndex
// ---------------------------------------------------------------------------

function reorderByIndex(pairs: Array<[number, ToolResultBlock]>, total: number): ToolResultBlock[] {
  const out: ToolResultBlock[] = new Array(total);
  for (const [i, block] of pairs) {
    out[i] = block;
  }
  return out;
}

// ---------------------------------------------------------------------------
// runOneToolCall — per-call driver shared by both lanes
//
// Promise-with-emit-sink shape (not an async generator) so it composes cleanly
// with the Promise.race-based mergeAsyncGenerators in the parallel lane. The
// per-call event stream is pushed through the `emit` callback as events arrive;
// the final ToolResultBlock pair is written into `resultSink.pair` ONLY on
// successful completion. AbortError is re-thrown; the close-bracket events
// (tool_call_end, optional skill_completed) are emitted BEFORE the throw, so
// the throwing tool's brackets are never orphaned.
// ---------------------------------------------------------------------------

async function runOneToolCall(
  call: ResolvedCall,
  idx: number,
  decision: PermissionDecision,
  ai: AgentInternal,
  si: SessionInternal,
  signal: AbortSignal,
  emit: (ev: Event) => void,
  resultSink: { pair?: [number, ToolResultBlock] },
): Promise<void> {
  const t0 = Date.now();
  const skillName = skillNameFromCall(call);
  if (skillName !== undefined) {
    const args = call.input.args;
    emit({
      type: "skill_invoked",
      name: skillName,
      ...(typeof args === "string" && { args }),
    });
  }
  emit({
    type: "tool_call_start",
    tool_use_id: call.id,
    tool_name: callToolName(call),
    input: effectiveInput(call, decision),
  });

  // Per-call queue: the tool may push events via ctx.emit during execute();
  // we forward them to the lane's `emit` sink as they arrive.
  const emitQueue = new ToolEventQueue();
  const execPromise = safeExecute(
    call,
    decision,
    ai,
    si,
    signal,
    (e) => emitQueue.push(e),
  ).finally(() => emitQueue.close());

  // Drain the per-tool emit queue concurrently with the execution. The queue's
  // close() in the finally above guarantees this loop terminates.
  const drainPromise = (async () => {
    for await (const ev of emitQueue) emit(ev);
  })();

  const [settled] = await Promise.allSettled([execPromise]);
  await drainPromise; // ensure all pre-close events flushed before bracket end

  if (settled!.status === "rejected") {
    emit({
      type: "tool_call_end",
      tool_use_id: call.id,
      tool_name: callToolName(call),
      is_error: true,
      duration_ms: Date.now() - t0,
    });
    if (skillName !== undefined) {
      emit({ type: "skill_completed", name: skillName, is_error: true });
    }
    throw settled!.reason;
  }

  const result = settled!.value;

  // PostToolUse — fires only for calls that actually ran (not immediate errors,
  // not permission/hook denials), including tool-level errors. Runs between
  // execute() settling and tool_call_end; hook latency is NOT folded into
  // duration_ms. Fail-open: a throwing hook leaves the result unchanged.
  let resultContent = result.content;
  const didExecute = !call.isImmediateError && decision.decision !== "deny";
  if (didExecute && ai.hookRunner.hasPostToolUse) {
    const post = await ai.hookRunner.runPostToolUse({
      tool: call.tool!,
      toolUseId: call.id,
      input: effectiveInput(call, decision),
      content: result.content,
      isError: result.is_error === true,
      durationMs: result.duration_ms,
      ctx: hookContextOf(ai, si, signal),
    });
    for (const e of post.errors) emit(e);
    resultContent = appendAdditionalContext(result.content, post.additionalContext);
  }

  emit({
    type: "tool_call_end",
    tool_use_id: call.id,
    tool_name: callToolName(call),
    is_error: result.is_error === true,
    duration_ms: result.duration_ms,
  });
  if (skillName !== undefined) {
    emit({ type: "skill_completed", name: skillName, is_error: result.is_error === true });
  }
  resultSink.pair = [idx, toToolResultBlock(call, { ...result, content: resultContent })];
}

// ---------------------------------------------------------------------------
// partitionByParallelSafe — adjacent-batch partitioning
//
// Walks the resolved calls in order and groups adjacent `parallelSafe` calls
// into one parallel batch; any non-`parallelSafe` (or immediate-error / unknown)
// call lands in its own serial batch of size 1. Preserves the model's intended
// call order — `[Read, Read, Bash, Read]` becomes 3 batches: par(Read,Read),
// ser(Bash), par(Read). Mirrors Claude Code's services/tools/toolOrchestration.ts.
// ---------------------------------------------------------------------------

interface Batch {
  parallel: boolean;
  calls: Array<[ResolvedCall, number, PermissionDecision]>;
}

function partitionByParallelSafe(
  resolved: ResolvedCall[],
  decisions: PermissionDecision[],
): Batch[] {
  const out: Batch[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const call = resolved[i]!;
    const parallel = !call.isImmediateError && call.tool?.parallelSafe === true;
    const last = out[out.length - 1];
    if (parallel && last?.parallel) {
      last.calls.push([call, i, decisions[i]!]);
    } else {
      out.push({ parallel, calls: [[call, i, decisions[i]!]] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// executeToolCalls — main export
//
// Ordering contract (post-refactor):
//   - PermissionRequestEvent (if any) precedes all start events for the turn.
//   - tool_call_start always precedes tool_call_end for the same tool_use_id.
//   - Batches are dispatched in arrival order (adjacent-batch partitioning by
//     parallelSafe). Events from earlier batches appear before later batches.
//   - Within a single tool: start → emitted events → end is preserved.
//   - Across concurrent tools in the same parallel batch: events interleave in
//     completion order — consumers must demultiplex by tool_use_id.
//   - On abort mid-parallel-batch: every started tool_use_id receives a
//     tool_call_end (real or synthetic with duration_ms: 0) before the throw,
//     so consumers tracking in-flight tools never leak entries.
// ---------------------------------------------------------------------------

export async function* executeToolCalls(
  blocks: ToolUseBlock[],
  ai: AgentInternal,
  si: SessionInternal,
  signal: AbortSignal,
): AsyncGenerator<Event, ToolResultBlock[]> {
  // 1. Resolve every block against the effective tool registry. The session's
  //    toolsOverride (set by the subagent runner) wins over the agent-wide
  //    registry so a filtered subagent only sees its allowed tools.
  const effectiveTools = si.toolsOverride ?? ai.tools;
  const resolved: ResolvedCall[] = blocks.map(b => resolveCall(b, effectiveTools));

  // Pass 0 — PreToolUse hooks. Runs to completion for every resolved,
  // non-immediate-error call before any permission evaluation, preserving the
  // "PermissionRequestEvent precedes all start events" contract. A hook may
  // rewrite the input (mutating call.input/summary so evaluate, the request
  // event, tool_call_start, and execute all see it), deny it outright, force the
  // ask path, or pre-allow it (bypassing rules + mode + canUseTool).
  const hookFinal: Array<PermissionDecision | undefined> = new Array(resolved.length);
  const hookAsk: boolean[] = new Array(resolved.length).fill(false);
  if (ai.hookRunner.hasPreToolUse) {
    const ctx = hookContextOf(ai, si, signal);
    for (let i = 0; i < resolved.length; i++) {
      throwIfAborted(signal);
      const call = resolved[i]!;
      if (call.isImmediateError) continue;
      const res = await ai.hookRunner.runPreToolUse({
        tool: call.tool!,
        toolUseId: call.id,
        input: call.input,
        summary: call.summary,
        ctx,
      });
      for (const e of res.errors) yield e;
      call.input = res.input;
      call.summary = res.summary;
      if (res.kind === "deny") hookFinal[i] = { decision: "deny", reason: res.reason! };
      else if (res.kind === "allow") hookFinal[i] = { decision: "allow" };
      else if (res.kind === "ask") hookAsk[i] = true;
      // "continue" → leave for normal evaluation on the (possibly rewritten) input.
    }
  }

  // 2. First pass — synchronous evaluate() to settle non-ask decisions and
  //    collect the calls that resolve to "ask". canUseTool is NOT invoked here,
  //    so the PermissionRequestEvent can be emitted before any callback runs.
  const decisions: PermissionDecision[] = new Array(resolved.length);
  const askIndices: number[] = [];

  for (let i = 0; i < resolved.length; i++) {
    const call = resolved[i]!;

    if (call.isImmediateError) {
      // Synthetic deny — permission resolution is skipped for immediate errors
      decisions[i] = { decision: "deny", reason: call.immediateErrorReason! };
      continue;
    }

    // A PreToolUse hook may have already settled this call.
    if (hookFinal[i] !== undefined) {
      decisions[i] = hookFinal[i]!;
      continue;
    }
    if (hookAsk[i]) {
      // Hook forced the ask path: skip evaluate(), join the ask set directly.
      askIndices.push(i);
      continue;
    }

    const initial = ai.permissionEngine.evaluate({
      tool_use_id: call.id,
      tool: call.tool!,
      input: call.input,
      cwd: ai.cwd,
    });

    if (initial.decision === "ask") {
      // One-turn additive allow set from a Skill overlay can upgrade "ask" to
      // "allow" without prompting. Existing deny rules still win above.
      if (si.currentTurnAllowedTools?.includes(call.tool!.name)) {
        decisions[i] = { decision: "allow" };
      } else {
        askIndices.push(i);
      }
    } else {
      // allow/deny from rules + mode are already final
      decisions[i] = initial;
    }
  }

  // 3. Emit a single PermissionRequestEvent for all ask-bound calls BEFORE
  //    canUseTool is invoked and before any tool starts. This lets an
  //    event-driven consumer render the request while the callback is pending.
  if (askIndices.length > 0) {
    yield {
      type: "permission_request",
      requests: askIndices.map(i => ({
        tool_use_id: resolved[i]!.id,
        tool_name: resolved[i]!.tool!.name,
        input: resolved[i]!.input,
        summary: resolved[i]!.summary,
      })),
    };
  }

  // 4. Second pass — resolve ask-bound calls (invokes canUseTool, which may
  //    rewrite input via updatedInput). Sequential, as canUseTool may prompt.
  //    A hook-forced ask uses resolveForcedAsk so canUseTool runs even when
  //    rules/mode would have allowed it (a matching deny rule still wins).
  for (const i of askIndices) {
    const call = resolved[i]!;
    const pending = { tool_use_id: call.id, tool: call.tool!, input: call.input, cwd: ai.cwd };
    try {
      decisions[i] = hookAsk[i]
        ? await ai.permissionEngine.resolveForcedAsk(pending, signal)
        : await ai.permissionEngine.resolve(pending, signal);
    } catch {
      // Permission resolution itself threw — treat as deny
      decisions[i] = {
        decision: "deny",
        reason: `Permission resolution failed for ${call.tool!.name}`,
      };
    }
  }

  // 5. Adjacent-batch partition by parallelSafe.
  const batches = partitionByParallelSafe(resolved, decisions);

  // 6. Drive each batch in order. Serial batches await each call; parallel
  //    batches use mergeAsyncGenerators with the Agent-level concurrency cap.
  const resultPairs: Array<[number, ToolResultBlock]> = [];

  for (const batch of batches) {
    throwIfAborted(signal);

    if (!batch.parallel) {
      // Serial lane: single call (a parallel run of length 1 is also possible,
      // but partitionByParallelSafe only emits parallel batches when the call
      // is parallelSafe — so non-parallel batches are length 1 here).
      for (const [call, idx, decision] of batch.calls) {
        const sink: { pair?: [number, ToolResultBlock] } = {};
        const queue = new ToolEventQueue();
        const runPromise = runOneToolCall(
          call, idx, decision, ai, si, signal,
          (e) => queue.push(e),
          sink,
        ).finally(() => queue.close());

        for await (const ev of queue) yield ev;
        await runPromise; // re-throws AbortError if rejected
        if (sink.pair) resultPairs.push(sink.pair);
      }
    } else {
      // Parallel lane: run all calls concurrently up to ai.toolConcurrency.
      // Each call's events flow into its own ToolEventQueue, then the per-call
      // generators are merged via Promise.race to interleave by arrival order.
      const sinks: Array<{ pair?: [number, ToolResultBlock]; error?: unknown }> =
        batch.calls.map(() => ({}));
      const startedIds = new Set<string>();
      const finishedIds = new Set<string>();
      const idToCall = new Map<string, ResolvedCall>();

      const generators = batch.calls.map(([call, idx, decision], local) => {
        const sink = sinks[local]!;
        return (async function* (): AsyncGenerator<Event, void> {
          const queue = new ToolEventQueue();
          // Capture any rejection into the sink so runPromise NEVER rejects.
          // A sibling generator can be abandoned mid-flight (another tool threw
          // AbortError, the merge exits) before reaching `await runPromise`; a
          // rejecting promise would then become an unhandled rejection.
          const runPromise = runOneToolCall(
            call, idx, decision, ai, si, signal,
            (ev) => {
              if (ev.type === "tool_call_start") {
                startedIds.add(ev.tool_use_id);
                idToCall.set(ev.tool_use_id, call);
              } else if (ev.type === "tool_call_end") {
                finishedIds.add(ev.tool_use_id);
              }
              queue.push(ev);
            },
            sink,
          ).catch((e) => { sink.error = e; }).finally(() => queue.close());

          for await (const ev of queue) yield ev;
          await runPromise; // settled (never rejects); rethrow below if needed
          if (sink.error) throw sink.error; // re-throws AbortError
        })();
      });

      let firstAbort: AbortError | undefined;
      try {
        for await (const ev of mergeAsyncGenerators(generators, ai.toolConcurrency)) {
          yield ev;
        }
      } catch (err) {
        if (err instanceof AbortError) firstAbort = err;
        else throw err;
      }

      // Orphan-bracket synthesis: emit a synthetic tool_call_end for every id
      // that emitted tool_call_start but never reached tool_call_end. This
      // keeps consumers tracking in-flight tools from leaking entries when one
      // tool throws AbortError and abandons sibling generators mid-flight.
      if (firstAbort !== undefined) {
        for (const id of startedIds) {
          if (!finishedIds.has(id)) {
            const call = idToCall.get(id);
            yield {
              type: "tool_call_end",
              tool_use_id: id,
              tool_name: call ? callToolName(call) : "unknown",
              is_error: true,
              duration_ms: 0,
            };
          }
        }
      }

      for (const s of sinks) if (s.pair) resultPairs.push(s.pair);
      if (firstAbort !== undefined) throw firstAbort;
    }
  }

  // 7. Reassemble results in original block order
  return reorderByIndex(resultPairs, blocks.length);
}
