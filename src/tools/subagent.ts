/** Subagent tool — spawns a child agent. See docs/12-subagents.html (pending). */

import { randomUUID } from "node:crypto";
import { ToolExecutionError } from "../core/errors.js";
import { DEFAULT_AGENT_TYPE } from "../subagents/default-agent.js";
import { runSubagent } from "../subagents/runner.js";
import type { Tool, ToolContext, ToolResult } from "./base.js";
import type { AgentRegistry } from "../subagents/registry.js";
import type { SessionInternal } from "../core/session.js";

export const SUBAGENT_TOOL_NAME = "Subagent";

export interface SubagentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    description: {
      type: "string",
      description: "Short 3-5 word label for the spawned subagent (shown in UI).",
    },
    prompt: {
      type: "string",
      description: "The task for the subagent. Provide complete context — the subagent has no parent history.",
    },
    subagent_type: {
      type: "string",
      description:
        "Optional: pick from the listed agent types. Omit to spawn a general-purpose subagent with full tool access.",
    },
  },
  required: ["description", "prompt"],
};

export interface SubagentToolOptions {
  /** Resolves agent definitions. Provided by Agent.connectSubagents. */
  registry: AgentRegistry;
  /** Look up the parent session's internals by id. Returns undefined when unknown. */
  getSessionInternal: (sessionId: string) => SessionInternal | undefined;
  /** Increment and return the next 'Agent #N' display name for this parent session. */
  nextDefaultDisplayName: (parentSessionId: string) => string;
}

export class SubagentTool implements Tool<SubagentInput> {
  readonly name = SUBAGENT_TOOL_NAME;
  // exec scope: the scheduler's sequential writes path is the one wired for
  // ctx.emit forwarding, which the runner uses to stream child events.
  readonly scope = "exec" as const;
  readonly parallelSafe = true;

  readonly input_schema = SCHEMA;

  // The catalog is fixed once the registry is built (at connect), so compute the
  // description once rather than rebuilding the string on every schemas() read.
  readonly description: string;

  constructor(private readonly opts: SubagentToolOptions) {
    const list = this.opts.registry.list();
    const header = "Launch a subagent to handle a focused task.";
    const trailer = [
      "Omit `subagent_type` to spawn a general-purpose subagent with full tool access.",
      "The subagent returns a single text response; its tool calls and partial output",
      "stream into your event log while it runs.",
    ].join("\n");
    this.description =
      list.length === 0
        ? [header, "", trailer].join("\n")
        : [
            header,
            "",
            "Available subagent types:",
            list.map((a) => `- ${a.name}: ${a.frontmatter.description}`).join("\n"),
            "",
            trailer,
          ].join("\n");
  }

  validate(raw: Record<string, unknown>): SubagentInput {
    const desc = raw.description;
    if (typeof desc !== "string" || desc.trim() === "") {
      throw new ToolExecutionError("description must be a non-empty string", {
        tool_name: this.name,
      });
    }
    const prompt = raw.prompt;
    if (typeof prompt !== "string" || prompt === "") {
      throw new ToolExecutionError("prompt must be a non-empty string", {
        tool_name: this.name,
      });
    }
    if (raw.subagent_type !== undefined && typeof raw.subagent_type !== "string") {
      throw new ToolExecutionError("subagent_type must be a string when provided", {
        tool_name: this.name,
      });
    }
    const out: SubagentInput = { description: desc, prompt };
    if (typeof raw.subagent_type === "string") out.subagent_type = raw.subagent_type;
    return out;
  }

  summarize(input: SubagentInput): string {
    return `Spawn subagent: ${input.description}`;
  }

  async execute(input: SubagentInput, ctx: ToolContext): Promise<ToolResult> {
    // Models tend to fill optional string fields with "" instead of omitting
    // them. Treat empty / whitespace-only subagent_type as "omitted" so the
    // built-in default agent runs. Also accept Claude's "general-purpose"
    // alias for the same reason (model habit, not promised API).
    const requested = input.subagent_type?.trim() ?? "";
    // Alias "general-purpose" to the built-in default only when no disk agent
    // claims that name — a real agent of that name must win. Lookup is
    // case-insensitive to match the registry.
    const aliasGeneralPurpose =
      requested.toLowerCase() === "general-purpose" &&
      this.opts.registry.get("general-purpose") === undefined;
    const subagentType =
      requested === "" || aliasGeneralPurpose ? DEFAULT_AGENT_TYPE : requested;
    const definition = this.opts.registry.get(subagentType);
    if (!definition) {
      const available = this.opts.registry.list().map((a) => a.name);
      const availText =
        available.length > 0
          ? `Available: ${available.join(", ")}. Or omit subagent_type to use the built-in default.`
          : `No named subagents are loaded; omit subagent_type to use the built-in default.`;
      return {
        content: `Unknown subagent_type '${subagentType}'. ${availText}`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    const parent = this.opts.getSessionInternal(ctx.sessionId);
    if (!parent) {
      // The parent session isn't in the registry. This is an internal invariant
      // (the Agent registers every session it creates) — fail loudly.
      return {
        content: `Internal error: parent session '${ctx.sessionId}' not registered.`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    const displayName =
      subagentType === DEFAULT_AGENT_TYPE
        ? this.opts.nextDefaultDisplayName(parent.id)
        : definition.frontmatter.name;

    const subagentRunId = `sa_${randomUUID().slice(0, 8)}`;

    const result = await runSubagent({
      parent,
      definition,
      prompt: input.prompt,
      displayName,
      subagentRunId,
      signal: ctx.signal,
      emit: ctx.emit ?? (() => {}),
    });

    // Build the user-visible response. If the subagent aborted, errored, or
    // produced no text, surface that as is_error so the parent model can react.
    if (result.aborted) {
      return {
        content: result.finalText
          ? `Subagent aborted. Partial output: ${result.finalText}`
          : "Subagent aborted before producing output.",
        summary: this.summarize(input),
        is_error: true,
      };
    }
    if (result.errored) {
      const errorText = result.error
        ? `${result.error.name}: ${result.error.message}`
        : undefined;
      return {
        content: [
          `Subagent encountered an error${errorText ? `: ${errorText}` : ""}.`,
          ...(result.finalText ? [`Partial output: ${result.finalText}`] : []),
        ].join(" "),
        summary: this.summarize(input),
        is_error: true,
      };
    }
    if (result.finalText === "") {
      return {
        content: "Subagent produced no text output.",
        summary: this.summarize(input),
        is_error: true,
      };
    }
    return {
      content: result.finalText,
      summary: this.summarize(input),
      is_error: false,
    };
  }
}
