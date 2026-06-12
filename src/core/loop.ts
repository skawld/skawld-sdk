/** Model-to-tool orchestration loop. See docs/05-agent-loop.html#loop. */

import { anySignal, throwIfAborted } from "./abort.js";
import { AbortError, ContextLengthError } from "./errors.js";
import { buildEnvUserPrefix } from "./system-prompt.js";
import { getAgentInternals } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { maybeCompact, runForcedCompaction } from "./compaction.js";
import { executeToolCalls } from "./scheduler.js";
import type { Event, PartialAssistantEvent, CompactionEvent } from "./events.js";
import { wrapInSystemReminder } from "../skills/system-reminder.js";
import { addUsage } from "./types.js";
import type {
  Message,
  ModelId,
  TextBlock,
  ImageBlock,
  ThinkingBlock,
  ToolUseBlock,
  StopReason,
  Usage,
} from "./types.js";
import type { Session, RunOptions, SessionInternal } from "./session.js";
import type { Agent, AgentInternal } from "./agent.js";
import type { ProviderRequest, ProviderStreamEvent } from "../providers/base.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function isToolUseBlock(b: { type: string }): b is ToolUseBlock {
  return b.type === "tool_use";
}

function extractFinalText(msg: Message): string | undefined {
  for (const block of msg.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

function skillListingBlock(skillListingText: string): TextBlock {
  return { type: "text", text: wrapInSystemReminder(`<skill_listing>\n${skillListingText}\n</skill_listing>`) };
}

function buildUserMessage(
  prompt: string,
  images?: RunOptions["images"],
  skillListingText?: string,
): Message {
  const envBlock: TextBlock = { type: "text", text: buildEnvUserPrefix() };
  const promptBlock: TextBlock = { type: "text", text: prompt };
  const imageBlocks: ImageBlock[] = (images ?? []).map(toImageBlock);
  const content: Message["content"] = [];
  if (skillListingText) content.push(skillListingBlock(skillListingText));
  content.push(envBlock, promptBlock, ...imageBlocks);
  return { role: "user", content };
}

function toImageBlock(img: { data: string; mediaType: string } | { url: string }): ImageBlock {
  if ("url" in img) {
    return { type: "image", source: { type: "url", url: img.url } };
  }
  return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } };
}

function buildRequest(
  si: SessionInternal,
  ai: AgentInternal,
  opts: RunOptions,
  signal: AbortSignal,
  modelOverride?: ModelId,
): ProviderRequest {
  // max_output_tokens precedence: per-run override > Agent-level default >
  // undefined (omit from request; provider decides what to do — see base.ts).
  const effectiveMaxOutput = opts.maxOutputTokens ?? ai.maxOutputTokens;
  const req: ProviderRequest = {
    model: modelOverride ?? ai.model,
    system: si.systemBlocksOverride ?? ai.systemBlocks,
    tools: (si.toolsOverride ?? ai.tools).schemas(),
    messages: si.providerView,
    ...(effectiveMaxOutput !== undefined && { max_output_tokens: effectiveMaxOutput }),
    temperature: opts.temperature,
    cache_prompt: true,
    // Skawld-managed provider retry budget. Provider adapters disable SDK
    // retries and apply this consistently around mapped retryable errors.
    max_retries: ai.maxRetries,
    signal,
  };
  if (ai.cacheTtl !== undefined) req.cache_ttl = ai.cacheTtl;
  if (opts.thinking !== undefined) req.thinking = opts.thinking;
  if (opts.effort !== undefined) req.effort = opts.effort;
  return req;
}

function buildCompactionEvent(si: SessionInternal): CompactionEvent {
  if (si.lastCompactionInfo) return si.lastCompactionInfo;
  throw new Error("invariant: lastCompactionInfo must be set after maybeCompact returns true");
}

// Re-inject the skill listing + any previously invoked skill bodies after a
// compaction so the model retains skill context once the older history is
// summarized. Pushes directly to providerView (in-memory only) — the store
// still has the originals; on resume the full history is replayed instead.
// Shared by the threshold path (runLoop) and the forced ContextLengthError
// recovery path (streamTurnWithContextRetry).
function reinjectSkillContext(si: SessionInternal, ai: AgentInternal): void {
  if (ai.skillListingText) {
    si.providerView.push({ role: "user", content: [skillListingBlock(ai.skillListingText)] });
  }
  for (const rec of si.invokedSkills) {
    si.providerView.push({
      role: "user",
      content: [{ type: "text", text: wrapInSystemReminder(rec.substitutedBody) }],
    });
  }
}

// ---------------------------------------------------------------------------
// streamTurn: async generator that yields PartialAssistantEvents and returns
// { assistantMessage, stopReason, usage } as its generator return value.
// ---------------------------------------------------------------------------

async function* streamTurn(
  provider: AgentInternal["provider"],
  req: ProviderRequest,
  includePartial: boolean,
): AsyncGenerator<PartialAssistantEvent, { assistantMessage: Message; stopReason: StopReason; usage: Usage }> {
  // Accumulation state
  let currentTextBuf = "";
  let currentThinkingBuf = "";
  let currentThinkingSig: string | undefined;

  // Per-tool-call accumulation keyed by id
  const toolInputBufs = new Map<string, string>();
  const toolBlocks = new Map<string, { id: string; name: string }>();

  // Final assembled content
  const contentBlocks: Array<TextBlock | ThinkingBlock | ToolUseBlock> = [];

  let stopReason: StopReason = "end_turn";
  let usage: Usage = zeroUsage();
  let providerMetadata: Message["provider_metadata"];

  // Helper: flush current text buffer into a TextBlock
  function flushText(): void {
    if (currentTextBuf.length > 0) {
      contentBlocks.push({ type: "text", text: currentTextBuf });
      currentTextBuf = "";
    }
  }

  // Helper: flush current thinking buffer into a ThinkingBlock
  function flushThinking(): void {
    if (currentThinkingBuf.length > 0) {
      contentBlocks.push({ type: "thinking", thinking: currentThinkingBuf, signature: currentThinkingSig });
      currentThinkingBuf = "";
      currentThinkingSig = undefined;
    }
  }

  for await (const event of provider.stream(req)) {
    const ev = event as ProviderStreamEvent;

    if (ev.type === "message_start") {
      // Nothing to accumulate — just marks start
    } else if (ev.type === "text_delta") {
      // Flush any open thinking run before switching to text
      flushThinking();
      currentTextBuf += ev.text;
      if (includePartial) {
        yield { type: "partial_assistant", delta: { kind: "text", text: ev.text } };
      }
    } else if (ev.type === "thinking_delta") {
      // Flush any open text run before switching to thinking
      flushText();
      currentThinkingBuf += ev.text;
      if (ev.signature !== undefined) {
        currentThinkingSig = ev.signature;
      }
      if (includePartial) {
        yield { type: "partial_assistant", delta: { kind: "thinking", text: ev.text } };
      }
    } else if (ev.type === "tool_use_start") {
      // Flush pending text/thinking before starting a tool block
      flushText();
      flushThinking();
      toolBlocks.set(ev.id, { id: ev.id, name: ev.name });
      toolInputBufs.set(ev.id, "");
    } else if (ev.type === "tool_use_input_delta") {
      const existing = toolInputBufs.get(ev.id) ?? "";
      toolInputBufs.set(ev.id, existing + ev.json_delta);
      if (includePartial) {
        yield {
          type: "partial_assistant",
          delta: { kind: "tool_use_input", tool_use_id: ev.id, json_delta: ev.json_delta },
        };
      }
    } else if (ev.type === "tool_use_end") {
      const meta = toolBlocks.get(ev.id);
      // Providers emit zero input deltas for a tool call whose input is `{}`
      // (Anthropic sends no input_json_delta; the OpenAI chat adapter forwards
      // deltas only when arguments are non-empty). Treat an empty/whitespace
      // buffer as `{}` so all-optional-param tools don't hit the invalid-JSON path.
      const rawJson = (toolInputBufs.get(ev.id) ?? "").trim() || "{}";
      if (meta) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(rawJson) as Record<string, unknown>;
        } catch {
          input = { __invalidJson: true, raw: rawJson };
        }
        contentBlocks.push({ type: "tool_use", id: meta.id, name: meta.name, input });
        toolBlocks.delete(ev.id);
        toolInputBufs.delete(ev.id);
      }
    } else if (ev.type === "message_end") {
      flushText();
      flushThinking();
      stopReason = ev.stop_reason;
      usage = ev.usage;
      providerMetadata = ev.provider_metadata;
    }
  }

  // Ensure any trailing text/thinking is flushed (in case message_end wasn't yielded)
  flushText();
  flushThinking();

  const assistantMessage: Message = {
    role: "assistant",
    // Cast is safe: all accumulated blocks match the Message content type
    content: contentBlocks as Message["content"],
  };
  if (providerMetadata !== undefined) {
    assistantMessage.provider_metadata = providerMetadata;
  }

  return { assistantMessage, stopReason, usage };
}

// ---------------------------------------------------------------------------
// streamTurnWithContextRetry: wraps streamTurn with one-shot ContextLengthError
// compaction retry per turn. Yields PartialAssistantEvent normally; on recovery
// also yields a CompactionEvent before the retry stream.
// ---------------------------------------------------------------------------

async function* streamTurnWithContextRetry(
  si: SessionInternal,
  ai: AgentInternal,
  opts: RunOptions,
  signal: AbortSignal,
  modelOverride?: ModelId,
): AsyncGenerator<PartialAssistantEvent | CompactionEvent, { assistantMessage: Message; stopReason: StopReason; usage: Usage }> {
  const req = buildRequest(si, ai, opts, signal, modelOverride);
  try {
    return yield* streamTurn(ai.provider, req, ai.includePartialMessages);
  } catch (err) {
    if (err instanceof ContextLengthError && !si.compactionRetryUsedThisTurn) {
      si.markCompactionUsed();
      // If the strategy could not reduce the view, re-sending would only
      // reproduce the same ContextLengthError — surface the original instead.
      if (!(await runForcedCompaction(si, ai, signal))) throw err;
      yield buildCompactionEvent(si);
      reinjectSkillContext(si, ai);
      // Retry uses the session's default model — the one-turn override is spent.
      const retryReq = buildRequest(si, ai, opts, signal);
      return yield* streamTurn(ai.provider, retryReq, ai.includePartialMessages);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runLoop: the main async generator.
// ---------------------------------------------------------------------------

export async function* runLoop(
  session: Session,
  prompt: string,
  opts: RunOptions,
): AsyncGenerator<Event> {
  const si = getSessionInternals(session);
  const agent: Agent = si.agent;
  const ai = getAgentInternals(agent);

  const runId = crypto.randomUUID();
  // Update the activeRunId from the placeholder "pending" set by Session.run()
  si.activeRunId = runId;

  const signal = anySignal([si.internalController.signal, opts.signal]);
  const startedAt = Date.now();
  let totalUsage: Usage = zeroUsage();

  // Emit SystemEvent first (before any side effects).
  // Tools come from the session's override (when set by the subagent runner)
  // so the SystemEvent reflects the registry the model actually sees.
  const effectiveTools = si.toolsOverride ?? ai.tools;
  yield {
    type: "system",
    subtype: "init",
    session_id: si.id,
    run_id: runId,
    model: ai.model,
    tools: effectiveTools.list().map(t => t.name).sort(),
    // Report the mode the engine actually evaluates against (snapshotted at
    // construction), not the publicly mutable opts.
    permission_mode: ai.permissionEngine.mode,
    cwd: ai.cwd,
  };

  // Emit SkillsLoadedEvent once per session, immediately after SystemEvent, only when skills exist.
  if (!si.skillsLoadedEmitted && ai.skills.size > 0) {
    si.skillsLoadedEmitted = true;
    const sortedSkills = [...ai.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
    yield {
      type: "skills_loaded",
      skills: sortedSkills.map(s => {
        const { whenToUse, argumentHint } = s.frontmatter;
        return {
          name: s.name,
          description: s.frontmatter.description,
          ...(whenToUse !== undefined && { when_to_use: whenToUse }),
          ...(argumentHint !== undefined && { argument_hint: argumentHint }),
        };
      }),
    };
  }

  // Inject skill_listing at the head of the first user message of a brand-new
  // session only. Suppressed for subagent runs (toolsOverride set) since the
  // child's filtered registry may not include the Skill tool, so surfacing a
  // listing it can't usefully invoke would mislead the model.
  const isFirstUserMessage = si.providerView.length === 0;
  const listingForFirstTurn =
    isFirstUserMessage && si.toolsOverride === undefined ? ai.skillListingText : undefined;
  const userMsg = buildUserMessage(prompt, opts.images, listingForFirstTurn);

  try {
    // Append inside the try so a store failure (SQLite locked, disk full)
    // surfaces as ErrorEvent + ResultEvent(error) rather than throwing raw.
    await si.append([userMsg]);
    yield { type: "user", message: userMsg };

    // maxTurns defaults to Infinity (unbounded): the loop runs until the model
    // stops calling tools, or the run aborts/errors. A finite maxTurns caps it
    // and falls through to the TurnLimitError below.
    for (let turn = 0; turn < ai.maxTurns; turn++) {
      throwIfAborted(signal);

      // Reset compaction retry flag at the top of every turn
      si.compactionRetryUsedThisTurn = false;

      // Compact when projected token usage exceeds 80% of the context window.
      if (await maybeCompact(si, ai, signal)) {
        yield buildCompactionEvent(si);
        reinjectSkillContext(si, ai);
      }

      // Consume any pending one-turn skill overlay (model override + additive
      // allow set). Cleared in finally below regardless of how the turn ends.
      const overlay = si.pendingSkillOverlay;
      si.pendingSkillOverlay = undefined;
      const modelOverride = overlay?.modelOverride;
      si.currentTurnAllowedTools = overlay?.allowedTools;

      try {
        // Stream the turn (yields PartialAssistantEvents, returns assembled result)
        const { assistantMessage, stopReason, usage } =
          yield* streamTurnWithContextRetry(si, ai, opts, signal, modelOverride);

        // Persist + emit assistant message
        await si.append([assistantMessage]);
        yield { type: "assistant", message: assistantMessage, stop_reason: stopReason };

        totalUsage = addUsage(totalUsage, usage);
        si.lastUsage = usage;
        yield { type: "usage", usage, cumulative: totalUsage };

        if (stopReason !== "tool_use") {
          yield {
            type: "result",
            subtype: "success",
            stop_reason: stopReason,
            total_usage: totalUsage,
            duration_ms: Date.now() - startedAt,
            final_text: extractFinalText(assistantMessage),
          };
          return;
        }

        // Fan out all tool_use blocks in parallel; collect results into a single user message.
        const toolUseBlocks = assistantMessage.content.filter(isToolUseBlock);
        const resultBlocks = yield* executeToolCalls(toolUseBlocks, ai, si, signal);

        // Aggregate all tool results into a single user message
        const userResultMsg: Message = {
          role: "user",
          content: resultBlocks,
        };
        await si.append([userResultMsg]);
        yield { type: "user", message: userResultMsg };
      } finally {
        si.currentTurnAllowedTools = undefined;
      }
    }

    // Turn cap exhausted
    yield {
      type: "error",
      error: { name: "TurnLimitError", message: "max turns exceeded", retryable: false },
    };
    yield {
      type: "result",
      subtype: "error",
      stop_reason: "error",
      total_usage: totalUsage,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof AbortError) {
      yield {
        type: "result",
        subtype: "aborted",
        stop_reason: "error",
        total_usage: totalUsage,
        duration_ms: Date.now() - startedAt,
      };
      return;
    }
    const e = err as { name?: string; message?: string; retryable?: boolean };
    yield {
      type: "error",
      error: {
        name: e.name ?? "Error",
        message: e.message ?? String(err),
        retryable: e.retryable ?? false,
        cause: err,
      },
    };
    yield {
      type: "result",
      subtype: "error",
      stop_reason: "error",
      total_usage: totalUsage,
      duration_ms: Date.now() - startedAt,
    };
  }
}
