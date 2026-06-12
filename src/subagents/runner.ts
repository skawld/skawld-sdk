/**
 * Subagent runner: spawn a child Session under the parent's Agent, drive it
 * synchronously, wrap each child event as `SubagentEvent`, and return the
 * child's final assistant text. See docs/12-subagents.html (pending).
 */

import os from "node:os";
import { getAgentInternals } from "../core/agent.js";
import { Session, getSessionInternals } from "../core/session.js";
import { buildSystemBlocks } from "../core/system-prompt.js";
import { SKAWLD_VERSION } from "../core/version.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Event } from "../core/events.js";
import type { SessionInternal } from "../core/session.js";
import type { AgentDefinition } from "./types.js";

const EXCLUDED_CHILD_TOOLS = new Set(["Subagent", "AskUser"]);

export interface RunSubagentArgs {
  /** Parent Session's internals — provides the agent reference + identity. */
  parent: SessionInternal;
  definition: AgentDefinition;
  /** User-message body for the child's first turn. */
  prompt: string;
  /** UI display name. 'Researcher' for named agents, 'Agent #N' for the default. */
  displayName: string;
  /** Unique per spawn — used to correlate SubagentEvent envelopes for this run. */
  subagentRunId: string;
  /**
   * Optional explicit tool filter. When omitted, the runner reads the filter off
   * the definition's frontmatter. `["*"]` or undefined = wildcard (pass-through
   * the parent's full registry). Tool names that don't resolve are silently
   * dropped at spawn time — see `buildChildTools`.
   */
  toolsFilter?: string[];
  /** Parent's tool-call signal. When fired, the child is aborted. */
  signal: AbortSignal;
  /** Push wrapped events into the parent's event stream. Wired from `ctx.emit`. */
  emit: (event: Event) => void;
}

export interface RunSubagentResult {
  childSessionId: string;
  /** The child's last assistant message text content (empty when none). */
  finalText: string;
  aborted: boolean;
  errored: boolean;
  error?: {
    name: string;
    message: string;
  };
}

/**
 * Build the child's filtered tool registry view.
 *
 * Wildcard (`undefined` or includes `"*"`) includes all parent tools except
 * `Subagent`. Otherwise a fresh ToolRegistry is built with only the named tools
 * that resolve in the parent; unknown names are silently dropped (matches
 * Claude). `Subagent` is always excluded so child agents cannot recurse.
 */
export function buildChildTools(
  parent: ToolRegistry,
  filter: string[] | undefined,
): ToolRegistry {
  const child = new ToolRegistry();
  const wildcard = filter === undefined || filter.includes("*");
  const wanted = wildcard ? undefined : new Set(filter);
  for (const t of parent.list()) {
    if (EXCLUDED_CHILD_TOOLS.has(t.name)) continue;
    if (wanted === undefined || wanted.has(t.name)) child.register(t);
  }
  return child;
}

/**
 * Spawn a subagent. Returns when the child's iterator terminates. Runtime
 * issues (provider errors, abort, child errors) are surfaced via the
 * `aborted`/`errored` flags rather than thrown.
 */
export async function runSubagent(args: RunSubagentArgs): Promise<RunSubagentResult> {
  const parent = args.parent;
  const agent = parent.agent;
  const ai = getAgentInternals(agent);
  const store = ai.getStore();

  const childRecord = await store.create({
    meta: {
      parentSessionId: parent.id,
      subagentType: args.definition.frontmatter.name,
      subagentRunId: args.subagentRunId,
      displayName: args.displayName,
    },
  });

  const toolsFilter = args.toolsFilter ?? args.definition.frontmatter.tools;
  const parentTools = parent.toolsOverride ?? ai.tools;
  const childTools = buildChildTools(parentTools, toolsFilter);

  // Agent body becomes the `userInstructions` block; identity/env/tool-protocol
  // blocks remain identical to the parent so cache prefixes line up.
  const childSystemBlocks = buildSystemBlocks({
    userInstructions: args.definition.body,
    cwd: ai.cwd,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    shell: process.env.SHELL ?? "unknown",
    nodeVersion: process.version,
    skawldVersion: SKAWLD_VERSION,
    toolNames: childTools.list().map((t) => t.name).sort(),
    permissionMode: agent.opts.permissions?.mode ?? "default",
  });

  // Construct the child Session directly so we bypass MCP/skills re-connect.
  // The child IS registered in `ai.sessions` so Skill calls from within can
  // look up its session by id (unregistered in finally).
  const childSession = new Session({
    record: childRecord,
    providerView: [],
    agent,
    store,
  });
  const childInternal = getSessionInternals(childSession);
  childInternal.toolsOverride = childTools;
  childInternal.systemBlocksOverride = childSystemBlocks;
  ai.registerSession(childRecord.id, childInternal);

  // Chain abort two ways: passing args.signal to Session.run covers
  // pre-abort/turn-boundary cases via anySignal; the listener covers
  // mid-stream aborts that fire after the loop is awaiting the provider.
  const onParentAbort = (): void => {
    childSession.abort(args.signal.reason);
  };
  if (!args.signal.aborted) {
    args.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let aborted = false;
  let errored = false;
  let lastError: RunSubagentResult["error"];
  // Track the LAST assistant message's joined text — not the
  // last-text-block-anywhere — so multi-block content (e.g. text/thinking/text)
  // is preserved within the final message.
  let lastAssistantText = "";
  try {
    // Inherit the parent's cost knobs (thinking, effort) — captured by
    // Session.run() on `parent.currentThinking` / `parent.currentEffort` when
    // the parent run started, undefined when the parent didn't set them.
    // Other RunOptions (temperature, images, maxOutputTokens) are turn- or
    // content-specific and intentionally NOT propagated.
    for await (const event of childSession.run(args.prompt, {
      signal: args.signal,
      ...(parent.currentThinking !== undefined && { thinking: parent.currentThinking }),
      ...(parent.currentEffort !== undefined && { effort: parent.currentEffort }),
    })) {
      args.emit({
        type: "subagent_event",
        parent_session_id: parent.id,
        subagent_run_id: args.subagentRunId,
        subagent_type: args.definition.frontmatter.name,
        display_name: args.displayName,
        event,
      });
      if (event.type === "assistant") {
        // Update unconditionally so the LAST assistant message's joined text
        // wins — even when empty (e.g. a final message with only tool_use
        // blocks). Docs/spec: docs/12-subagents.html "last assistant message's
        // text", which means literally the last, not the last-non-empty.
        lastAssistantText = event.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
      } else if (event.type === "result" && event.subtype === "aborted") {
        aborted = true;
      } else if (event.type === "error") {
        errored = true;
        lastError = {
          name: event.error.name,
          message: event.error.message,
        };
      }
    }
  } catch (err) {
    // runLoop converts everything to a terminal ResultEvent; defense in depth.
    errored = true;
    lastError = {
      name: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    args.signal.removeEventListener("abort", onParentAbort);
    ai.sessions.delete(childRecord.id);
  }

  return {
    childSessionId: childRecord.id,
    finalText: lastAssistantText,
    aborted,
    errored,
    ...(lastError !== undefined && { error: lastError }),
  };
}
