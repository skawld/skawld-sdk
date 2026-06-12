import type { Tool } from "../tools/base.js";
import type { PermissionMode } from "./mode.js";
import {
  evaluateBashRules,
  matchPathRule,
  matchToolRule,
  type BashRule,
  type PermissionRule,
} from "./rules.js";

export type PermissionDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  | { decision: "deny"; reason: string }
  | { decision: "ask" };

export interface PendingToolCall {
  tool_use_id: string;
  tool: Tool<any>;
  input: Record<string, unknown>;
  /**
   * Working directory used to resolve relative paths in the tool input
   * (per the spec: relative inputs resolve against ctx.cwd). Defaults to the
   * engine's projectRoot when omitted.
   */
  cwd?: string;
}

export interface CanUseToolRequest {
  tool_name: string;
  tool_use_id: string;
  input: Record<string, unknown>;
  summary: string;
  mode: PermissionMode;
}

export type CanUseToolResponse =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type CanUseTool = (req: CanUseToolRequest, signal: AbortSignal) => Promise<CanUseToolResponse>;

export interface PermissionEngineOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
  canUseTool?: CanUseTool;
  projectRoot: string;
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
export class PermissionEngine {
  constructor(private readonly opts: PermissionEngineOptions) {}

  /** The mode this engine evaluates against — snapshotted at construction. */
  get mode(): PermissionMode {
    return this.opts.mode;
  }

  evaluate(call: PendingToolCall): PermissionDecision {
    const invalidReason = validatePendingCall(call);
    if (invalidReason !== undefined) return { decision: "deny", reason: invalidReason };

    const ruleDecision = this.evaluateRules(call);
    if (ruleDecision !== undefined) return ruleDecision;
    return modeDefault(call.tool, this.opts.mode);
  }

  async resolve(call: PendingToolCall, signal: AbortSignal): Promise<PermissionDecision> {
    const initial = this.evaluate(call);
    if (initial.decision !== "ask") return initial;
    return this.invokeCanUseTool(call, signal);
  }

  /**
   * Force the canUseTool ask path for a call even when rules or mode would have
   * allowed it. Used by a PreToolUse hook's `action: "ask"`: a matching deny rule
   * still wins, but everything else goes through canUseTool rather than
   * auto-allowing. Validation mirrors {@link evaluate}.
   */
  async resolveForcedAsk(call: PendingToolCall, signal: AbortSignal): Promise<PermissionDecision> {
    const invalidReason = validatePendingCall(call);
    if (invalidReason !== undefined) return { decision: "deny", reason: invalidReason };
    const ruleDecision = this.evaluateRules(call);
    if (ruleDecision?.decision === "deny") return ruleDecision;
    return this.invokeCanUseTool(call, signal);
  }

  /** Invoke canUseTool for an ask-bound call and validate its response. */
  private async invokeCanUseTool(call: PendingToolCall, signal: AbortSignal): Promise<PermissionDecision> {
    const canUseTool = this.opts.canUseTool;
    if (canUseTool === undefined) {
      return { decision: "deny", reason: `Permission denied for ${call.tool.name}: canUseTool callback is not configured.` };
    }
    if (signal.aborted) {
      return { decision: "deny", reason: `Permission denied for ${call.tool.name}: permission request aborted.` };
    }

    let response: unknown;
    try {
      response = await withAbort(
        canUseTool({
          tool_name: call.tool.name,
          tool_use_id: call.tool_use_id,
          input: call.input,
          summary: call.tool.summarize(call.input),
          mode: this.opts.mode,
        }, signal),
        signal,
      );
    } catch {
      return { decision: "deny", reason: `Permission denied for ${call.tool.name}: permission callback failed or aborted.` };
    }

    if (!isRecord(response)) {
      return invalidCallbackResponseDecision(call.tool.name);
    }
    if (response.behavior === "deny") {
      if (typeof response.message !== "string") {
        return invalidCallbackResponseDecision(call.tool.name);
      }
      return { decision: "deny", reason: response.message };
    }
    if (response.behavior !== "allow") {
      return invalidCallbackResponseDecision(call.tool.name);
    }
    if (!hasOwn(response, "updatedInput")) {
      return { decision: "allow" };
    }
    if (!isRecord(response.updatedInput)) {
      return invalidCallbackResponseDecision(call.tool.name);
    }

    try {
      const validated = call.tool.validate(response.updatedInput);
      if (!isRecord(validated)) {
        return { decision: "deny", reason: `Permission denied for ${call.tool.name}: updated input is invalid.` };
      }
      return { decision: "allow", updatedInput: validated };
    } catch {
      return { decision: "deny", reason: `Permission denied for ${call.tool.name}: updated input is invalid.` };
    }
  }

  private evaluateRules(call: PendingToolCall): PermissionDecision | undefined {
    // The first bash rule encountered evaluates the entire bash rule set in order;
    // later bash rules would only re-run a strictly smaller subset that already
    // returned undefined, so evaluate the bash set at most once.
    let bashEvaluated = false;
    for (let index = 0; index < this.opts.rules.length; index++) {
      const rule = this.opts.rules[index];
      if (rule === undefined) continue;

      if (rule.kind === "tool" && matchToolRule(rule, call)) {
        return fromRuleDecision(rule.decision, `${rule.kind} rule matched ${call.tool.name}.`);
      }
      if (rule.kind === "path" && matchPathRule(rule, call, this.opts.projectRoot)) {
        return fromRuleDecision(rule.decision, `${rule.kind} rule matched ${call.tool.name}.`);
      }
      if (rule.kind === "bash" && call.tool.name === "Bash" && !bashEvaluated) {
        bashEvaluated = true;
        const command = call.input.command;
        if (typeof command !== "string") continue;
        const bashDecision = evaluateBashRules(bashRulesFrom(this.opts.rules, index), command);
        if (bashDecision !== undefined) {
          return fromRuleDecision(bashDecision, `${rule.kind} rule matched ${call.tool.name}.`);
        }
      }
    }
    return undefined;
  }
}

function modeDefault(tool: Tool<any>, mode: PermissionMode): PermissionDecision {
  if (tool.scope === "read" || TASK_TOOL_NAMES.has(tool.name)) return { decision: "allow" };
  if (mode === "yolo") return { decision: "allow" };
  if (tool.scope === "write" && mode === "acceptEdits") return { decision: "allow" };
  return { decision: "ask" };
}
function fromRuleDecision(decision: "allow" | "deny", reason: string): PermissionDecision {
  return decision === "allow" ? { decision: "allow" } : { decision: "deny", reason };
}
function bashRulesFrom(rules: readonly PermissionRule[], startIndex: number): BashRule[] {
  return rules.slice(startIndex).filter((rule): rule is BashRule => rule.kind === "bash");
}
function validatePendingCall(call: PendingToolCall): string | undefined {
  if (!isRecord(call)) return "Invalid permission call: call must be an object.";
  if (typeof call.tool_use_id !== "string" || call.tool_use_id.trim() === "") {
    return "Invalid permission call: tool_use_id must be a non-empty string.";
  }
  if (!isRecord(call.input)) return "Invalid permission call: input must be an object.";
  if (!isToolLike(call.tool)) return "Invalid permission call: tool is invalid.";
  return undefined;
}

function invalidCallbackResponseDecision(toolName: string): PermissionDecision {
  return { decision: "deny", reason: `Permission denied for ${toolName}: permission callback returned an invalid response.` };
}

function isToolLike(tool: unknown): tool is Tool<any> {
  if (!isRecord(tool)) return false;
  return (
    typeof tool.name === "string" &&
    typeof tool.scope === "string" &&
    typeof tool.validate === "function" &&
    typeof tool.summarize === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aborted");
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
