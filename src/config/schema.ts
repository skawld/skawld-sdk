/** Config schema, warning type, and a hand-rolled validator (module 09). */

import type { PermissionMode } from "../core/types.js";
import type { PermissionRule } from "../permissions/rules.js";
import { ConfigError } from "../core/errors.js";

export type ProviderId = "anthropic" | "openai-chat" | "openai-responses";

export interface SkawldConfig {
  /** Provider id and per-provider options. */
  provider?: {
    id: ProviderId;
    apiKey?: string;
    baseURL?: string;
    /** Free-form per-provider options forwarded to the constructor. */
    options?: Record<string, unknown>;
  };

  /** Default model id. Programmatic overrides take precedence. */
  model?: string;

  /** Working directory. Default is process.cwd(). */
  cwd?: string;

  /** System prompt addendum (maps to AgentOptions.systemPrompt). */
  systemPrompt?: string;
  /** Path to a system prompt addendum file. Resolved (not read) by the loader. */
  systemPromptFile?: string;

  /** Permissions: mode + rules. canUseTool is code-only, never in config. */
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
  };

  /** Run-time limits. */
  limits?: {
    maxTurns?: number;
    maxOutputTokens?: number;
    maxRetries?: number;
  };

  /** Session store. v1 supports only "sqlite" and "memory" via config. */
  sessionStore?:
    | { kind: "sqlite"; databasePath?: string }
    | { kind: "memory" };
}

/** A non-fatal problem found while loading. The loader never prints. */
export interface ConfigWarning {
  /** Absolute path of the config file the warning refers to, when file-scoped. */
  file?: string;
  /** JSON Pointer to the offending key, when key-scoped (e.g. "/outpt"). */
  pointer?: string;
  message: string;
}

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai-chat", "openai-responses"];
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "yolo"];
export const SESSION_KINDS = ["sqlite", "memory"] as const;

const TOP_LEVEL_KEYS = new Set([
  "provider", "model", "cwd", "systemPrompt", "systemPromptFile", "permissions", "limits", "sessionStore",
]);

export interface ValidateContext {
  /** Absolute path of the source file, for error/warning messages. */
  file?: string;
  warnings: ConfigWarning[];
}

type Fail = (pointer: string, message: string) => never;

/**
 * Validate raw parsed JSON against SkawldConfig. Unknown top-level keys become
 * warnings; unknown nested keys, type errors, and bad enums throw ConfigError
 * carrying the offending JSON Pointer.
 */
export function validateConfig(raw: unknown, ctx: ValidateContext): SkawldConfig {
  const fail: Fail = (pointer, message) => {
    const loc = ctx.file ? ` in ${ctx.file}` : "";
    throw new ConfigError(`Invalid config${loc} (${pointer || "/"}): ${message}`);
  };
  if (!isObject(raw)) fail("", "config root must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const out: SkawldConfig = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    switch (key) {
      case "provider": out.provider = validateProvider(value, fail); break;
      case "model": out.model = asString(value, "/model", fail); break;
      case "cwd": out.cwd = asString(value, "/cwd", fail); break;
      case "systemPrompt": out.systemPrompt = asString(value, "/systemPrompt", fail); break;
      case "systemPromptFile": out.systemPromptFile = asString(value, "/systemPromptFile", fail); break;
      case "permissions": out.permissions = validatePermissions(value, fail); break;
      case "limits": out.limits = validateLimits(value, fail); break;
      case "sessionStore": out.sessionStore = validateSessionStore(value, fail); break;
      default:
        if (!TOP_LEVEL_KEYS.has(key)) {
          ctx.warnings.push({ file: ctx.file, pointer: `/${key}`, message: `Unknown config key "${key}" ignored` });
        }
    }
  }
  return out;
}

function validateProvider(value: unknown, fail: Fail): SkawldConfig["provider"] {
  const o = asObject(value, "/provider", fail);
  rejectUnknown(o, ["id", "apiKey", "baseURL", "options"], "/provider", fail);
  if (typeof o.id !== "string" || !PROVIDER_IDS.includes(o.id as ProviderId)) {
    fail("/provider/id", `must be one of ${PROVIDER_IDS.join(", ")}`);
  }
  const provider: NonNullable<SkawldConfig["provider"]> = { id: o.id as ProviderId };
  if (o.apiKey !== undefined) provider.apiKey = asString(o.apiKey, "/provider/apiKey", fail);
  if (o.baseURL !== undefined) provider.baseURL = asString(o.baseURL, "/provider/baseURL", fail);
  if (o.options !== undefined) provider.options = asObject(o.options, "/provider/options", fail);
  return provider;
}

function validatePermissions(value: unknown, fail: Fail): SkawldConfig["permissions"] {
  const o = asObject(value, "/permissions", fail);
  rejectUnknown(o, ["mode", "rules"], "/permissions", fail);
  const out: NonNullable<SkawldConfig["permissions"]> = {};
  if (o.mode !== undefined) {
    if (typeof o.mode !== "string" || !PERMISSION_MODES.includes(o.mode as PermissionMode)) {
      fail("/permissions/mode", `must be one of ${PERMISSION_MODES.join(", ")}`);
    }
    out.mode = o.mode as PermissionMode;
  }
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules)) fail("/permissions/rules", "must be an array");
    out.rules = o.rules.map((rule, i) => validateRule(rule, i, fail));
  }
  return out;
}

function validateRule(value: unknown, i: number, fail: Fail): PermissionRule {
  const base = `/permissions/rules/${i}`;
  const o = asObject(value, base, fail);
  if (o.decision !== "allow" && o.decision !== "deny") fail(`${base}/decision`, `must be "allow" or "deny"`);
  const decision = o.decision as "allow" | "deny";
  switch (o.kind) {
    case "tool": {
      rejectUnknown(o, ["kind", "tool", "arg", "decision"], base, fail);
      const tool = asString(o.tool, `${base}/tool`, fail);
      const rule: PermissionRule = { kind: "tool", tool, decision };
      if (o.arg !== undefined) rule.arg = asString(o.arg, `${base}/arg`, fail);
      return rule;
    }
    case "path": {
      rejectUnknown(o, ["kind", "tools", "paths", "decision"], base, fail);
      if (!isStringArray(o.paths)) fail(`${base}/paths`, "must be an array of strings");
      const rule: PermissionRule = { kind: "path", paths: o.paths as string[], decision };
      if (o.tools !== undefined) {
        if (!isStringArray(o.tools)) fail(`${base}/tools`, "must be an array of strings");
        rule.tools = o.tools as string[];
      }
      return rule;
    }
    case "bash": {
      rejectUnknown(o, ["kind", "pattern", "decision"], base, fail);
      return { kind: "bash", pattern: validateBashPattern(o.pattern, base, fail), decision };
    }
    default:
      return fail(`${base}/kind`, `must be one of "tool", "path", "bash"`);
  }
}

function validateBashPattern(value: unknown, base: string, fail: Fail): string | { regex: string } {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof (value as Record<string, unknown>).regex === "string") {
    const regex = (value as Record<string, unknown>).regex as string;
    try {
      new RegExp(regex);
    } catch (err) {
      fail(`${base}/pattern/regex`, `invalid regular expression: ${(err as Error).message}`);
    }
    return { regex };
  }
  return fail(`${base}/pattern`, `must be a string or { regex: string }`);
}

function validateLimits(value: unknown, fail: Fail): SkawldConfig["limits"] {
  const o = asObject(value, "/limits", fail);
  rejectUnknown(o, ["maxTurns", "maxOutputTokens", "maxRetries"], "/limits", fail);
  const out: NonNullable<SkawldConfig["limits"]> = {};
  if (o.maxTurns !== undefined) out.maxTurns = asBoundedInt(o.maxTurns, 1, "/limits/maxTurns", fail);
  if (o.maxOutputTokens !== undefined) out.maxOutputTokens = asBoundedInt(o.maxOutputTokens, 1, "/limits/maxOutputTokens", fail);
  if (o.maxRetries !== undefined) out.maxRetries = asBoundedInt(o.maxRetries, 0, "/limits/maxRetries", fail);
  return out;
}

function validateSessionStore(value: unknown, fail: Fail): SkawldConfig["sessionStore"] {
  const o = asObject(value, "/sessionStore", fail);
  if (o.kind === "sqlite") {
    rejectUnknown(o, ["kind", "databasePath"], "/sessionStore", fail);
    const store: SkawldConfig["sessionStore"] = { kind: "sqlite" };
    if (o.databasePath !== undefined) store.databasePath = asString(o.databasePath, "/sessionStore/databasePath", fail);
    return store;
  }
  if (o.kind === "memory") {
    rejectUnknown(o, ["kind"], "/sessionStore", fail);
    return { kind: "memory" };
  }
  return fail("/sessionStore/kind", `must be one of ${SESSION_KINDS.join(", ")}`);
}

// --- primitive helpers ---

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asObject(v: unknown, pointer: string, fail: Fail): Record<string, unknown> {
  if (!isObject(v)) fail(pointer, "must be an object");
  return v as Record<string, unknown>;
}
function asString(v: unknown, pointer: string, fail: Fail): string {
  if (typeof v !== "string") fail(pointer, "must be a string");
  return v as string;
}
function asBoundedInt(v: unknown, min: number, pointer: string, fail: Fail): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) fail(pointer, `must be an integer ≥ ${min}`);
  return v as number;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function rejectUnknown(o: Record<string, unknown>, known: string[], pointer: string, fail: Fail): void {
  for (const key of Object.keys(o)) {
    if (!known.includes(key)) fail(`${pointer}/${key}`, `unknown key "${key}"`);
  }
}
