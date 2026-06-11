import path from "node:path";
import picomatch from "picomatch";
import type { Tool } from "../tools/base.js";

export type PermissionRule = ToolRule | PathRule | BashRule;

export interface ToolRule {
  kind: "tool";
  tool: string;
  /**
   * Optional first-positional-argument match. Currently meaningful only for the
   * `Skill` tool, where it matches `input.skill`. Use `"*"` to match any skill name.
   * When omitted on Skill rules, the rule matches any skill name (legacy behavior).
   */
  arg?: string;
  decision: "allow" | "deny";
}

export interface PathRule {
  kind: "path";
  tools?: string[];
  paths: string[];
  decision: "allow" | "deny";
}

export interface BashRule {
  kind: "bash";
  pattern: string | { regex: string };
  decision: "allow" | "deny";
}

export interface RuleToolCall {
  tool: Pick<Tool, "name"> | string;
  input: Record<string, unknown>;
  /** Working directory used to resolve relative paths in the tool input. */
  cwd?: string;
}

export function matchToolRule(rule: ToolRule, call: RuleToolCall): boolean {
  const callName = toolName(call);
  if (rule.tool !== "*" && rule.tool !== callName) return false;
  if (rule.arg === undefined) return true;
  // arg matching currently only meaningful for the Skill tool, where input.skill is the arg.
  if (callName !== "Skill") return false;
  if (rule.arg === "*") return true;
  const skillName = call.input.skill;
  return typeof skillName === "string" && skillName === rule.arg;
}

export function matchPathRule(rule: PathRule, call: RuleToolCall, projectRoot: string): boolean {
  const name = toolName(call);
  const tools = rule.tools ?? ["Write", "Edit"];
  if (!tools.includes(name)) return false;
  const cwd = call.cwd ?? projectRoot;
  const rawPath = pathInputForTool(name, call.input, cwd);
  if (rawPath === undefined) return false;
  const target = normalizeForGlob(path.resolve(cwd, rawPath));
  const patternRoot = path.resolve(projectRoot);
  return rule.paths.some((pattern) => matchesPathPattern(pattern, target, patternRoot));
}

export function matchBashRule(rule: BashRule, commandSegment: string): boolean {
  const segment = commandSegment.trim();
  if (typeof rule.pattern === "string") {
    return tokensStartWith(tokenizeShellPrefix(segment), tokenizeShellPrefix(rule.pattern));
  }
  const regex = createBashRegex(rule.pattern.regex);
  return regex?.test(segment) ?? false;
}

export function evaluateBashRules(
  rules: readonly BashRule[],
  command: string,
): "allow" | "deny" | undefined {
  const segments = splitCompositeCommand(command).filter((segment) => segment.trim() !== "");
  if (segments.length === 0) return undefined;
  let allAllowed = true;
  for (const segment of segments) {
    const decision = firstMatchingBashDecision(rules, segment);
    if (decision === "deny") return "deny";
    if (decision !== "allow") allAllowed = false;
  }
  return allAllowed ? "allow" : undefined;
}

export function tokenizeShellPrefix(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let inToken = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === undefined) continue;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") {
        quote = undefined;
      } else if (char === "\\" && i + 1 < input.length) {
        current += input[++i] ?? "";
      } else {
        current += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    inToken = true;
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (char === "\\" && i + 1 < input.length) {
      current += input[++i] ?? "";
    } else {
      current += char;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

export function splitCompositeCommand(input: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== "'" && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    const operatorLength = compositeOperatorLength(input, i);
    if (operatorLength > 0) {
      segments.push(input.slice(start, i));
      i += operatorLength - 1;
      start = i + 1;
    }
  }
  segments.push(input.slice(start));
  return segments;
}
function toolName(call: RuleToolCall): string {
  return typeof call.tool === "string" ? call.tool : call.tool.name;
}
function pathInputForTool(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    return typeof input.file_path === "string" && input.file_path.trim() !== "" ? input.file_path : undefined;
  }
  if (tool === "Glob" || tool === "Grep") {
    return typeof input.path === "string" && input.path.trim() !== "" ? input.path : cwd;
  }
  return undefined;
}
function matchesPathPattern(pattern: string, target: string, projectRoot: string): boolean {
  const inverted = pattern.startsWith("!");
  const body = inverted ? pattern.slice(1) : pattern;
  if (body === "") return false;
  const absolutePattern = path.isAbsolute(body) ? body : path.resolve(projectRoot, body);
  const matcher = picomatch(normalizeForGlob(absolutePattern), { dot: true });
  const matched = matcher(target);
  return inverted ? !matched : matched;
}
function normalizeForGlob(value: string): string {
  return value.replaceAll(path.sep, "/");
}
function tokensStartWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > tokens.length) return false;
  return prefix.every((token, index) => tokens[index] === token);
}
function firstMatchingBashDecision(rules: readonly BashRule[], commandSegment: string): "allow" | "deny" | undefined {
  for (const rule of rules) {
    if (matchBashRule(rule, commandSegment)) return rule.decision;
  }
  return undefined;
}
function createBashRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
function compositeOperatorLength(input: string, index: number): number {
  const char = input[index];
  const next = input[index + 1];
  if ((char === "&" && next === "&") || (char === "|" && next === "|")) return 2;
  if (char === ";" || char === "|") return 1;
  // sh -c also treats unquoted newlines and a standalone background `&` as
  // command separators; missing them would let a later command ride through
  // on the first segment's allow decision.
  if (char === "\n" || char === "\r" || char === "&") return 1;
  return 0;
}
