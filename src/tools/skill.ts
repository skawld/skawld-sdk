/** Skill tool — invokes a loaded skill by name. See docs/11-skills.html. */

import type { Tool, ToolContext, ToolResult } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";
import type { Skill } from "../skills/types.js";
import { substituteSkillBody } from "../skills/substitute.js";
import { resolveModelOverride } from "../skills/overlay.js";
import type { ModelId, SkillOverlay } from "../core/types.js";
import type { SessionInternal } from "../core/session.js";

export interface SkillInput {
  skill: string;
  args?: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    skill: { type: "string", description: "Name of the skill to invoke." },
    args: { type: "string", description: "Optional argument string forwarded to the skill body." },
  },
  required: ["skill"],
};

export interface SkillToolOptions {
  /** Loaded skill set keyed by name. Read by reference — the Agent owns the map. */
  skills: ReadonlyMap<string, Skill>;
  /** Look up session internals by id; returns undefined for unknown sessions. */
  getSessionInternal: (sessionId: string) => SessionInternal | undefined;
  /** Returns the active session model so [1m] suffix can be carried forward. */
  getSessionModel: (sessionId: string) => ModelId;
}

export class SkillTool implements Tool<SkillInput> {
  readonly name = "Skill";
  readonly description =
    "Invoke a skill by name. Skills are listed in the skill_listing system-reminder. " +
    "The skill's body is returned to you so you can act on its instructions in the next turn.";
  readonly input_schema = SCHEMA;
  readonly scope = "exec" as const;
  readonly parallelSafe = false;

  constructor(private readonly opts: SkillToolOptions) {}

  validate(raw: Record<string, unknown>): SkillInput {
    if (typeof raw.skill !== "string" || raw.skill.trim() === "") {
      throw new ToolExecutionError("skill must be a non-empty string", { tool_name: this.name });
    }
    if (raw.args !== undefined && typeof raw.args !== "string") {
      throw new ToolExecutionError("args must be a string", { tool_name: this.name });
    }
    return raw.args !== undefined
      ? { skill: raw.skill, args: raw.args as string }
      : { skill: raw.skill };
  }

  summarize(input: SkillInput): string {
    return `Invoke skill: ${input.skill}`;
  }

  async execute(input: SkillInput, ctx: ToolContext): Promise<ToolResult> {
    const raw = input.skill.startsWith("/") ? input.skill.slice(1) : input.skill;
    // Names are normalized to lowercase at load (the grammar is case-insensitive).
    const requested = raw.toLowerCase();
    const skill = this.opts.skills.get(requested);
    if (!skill) {
      return {
        content: `Unknown skill: ${requested}`,
        summary: `Invoke skill: ${requested}`,
        is_error: true,
      };
    }
    if (skill.frontmatter.disableModelInvocation) {
      return {
        content: `Skill is not invokable by the model: ${skill.name}`,
        summary: `Invoke skill: ${skill.name}`,
        is_error: true,
      };
    }

    const args = input.args ?? "";
    const substituted = substituteSkillBody({ skill, args, sessionId: ctx.sessionId });

    const si = this.opts.getSessionInternal(ctx.sessionId);
    if (si) {
      si.invokedSkills.push({
        name: skill.name,
        substitutedBody: substituted,
        invokedAt: Date.now(),
      });
      // Persist so resume re-emits this invocation after compaction strips messages.
      try {
        await ctx.sessionStore.setInvokedSkills(ctx.sessionId, si.invokedSkills.slice());
      } catch {
        // Persistence failure should not block model interaction. The in-memory
        // record is still authoritative for the current session.
      }

      const { allowedTools, model } = skill.frontmatter;
      const overlay: SkillOverlay = {};
      if (allowedTools && allowedTools.length > 0) overlay.allowedTools = allowedTools.slice();
      if (model) {
        overlay.modelOverride = resolveModelOverride(model, this.opts.getSessionModel(ctx.sessionId));
      }
      if (overlay.allowedTools !== undefined || overlay.modelOverride !== undefined) {
        si.pendingSkillOverlay = overlay;
      }
    }

    return {
      content: substituted,
      summary: `Invoked skill: ${skill.name}`,
      is_error: false,
    };
  }
}
