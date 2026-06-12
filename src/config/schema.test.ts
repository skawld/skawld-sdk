import { describe, expect, test } from "bun:test";
import { ConfigError } from "../core/errors.js";
import { validateConfig, type ConfigWarning } from "./schema.js";

function validate(raw: unknown) {
  const warnings: ConfigWarning[] = [];
  const config = validateConfig(raw, { file: "/p/.skawld/config.json", warnings });
  return { config, warnings };
}

describe("validateConfig — shape", () => {
  test("accepts an empty object", () => {
    expect(validate({}).config).toEqual({});
  });

  test("rejects a non-object root", () => {
    expect(() => validate([])).toThrow(ConfigError);
    expect(() => validate("x")).toThrow(ConfigError);
    expect(() => validate(null)).toThrow(ConfigError);
  });

  test("accepts a full valid config", () => {
    const { config } = validate({
      provider: { id: "anthropic", apiKey: "sk", baseURL: "https://x", options: { a: 1 } },
      model: "claude-sonnet-4-6",
      cwd: "/work",
      systemPrompt: "hi",
      systemPromptFile: "./i.md",
      permissions: {
        mode: "default",
        rules: [
          { kind: "bash", pattern: "git status", decision: "allow" },
          { kind: "bash", pattern: { regex: "\\brm\\b" }, decision: "deny" },
          { kind: "tool", tool: "Bash", arg: "x", decision: "allow" },
          { kind: "path", paths: ["**"], tools: ["Write"], decision: "deny" },
        ],
      },
      limits: { maxTurns: 200, maxOutputTokens: 1000, maxRetries: 0 },
      sessionStore: { kind: "sqlite", databasePath: "./db" },
    });
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.permissions?.rules).toHaveLength(4);
    expect(config.sessionStore).toEqual({ kind: "sqlite", databasePath: "./db" });
  });
});

describe("validateConfig — unknown keys", () => {
  test("unknown top-level key → warning, not error", () => {
    const { config, warnings } = validate({ output: "x", model: "m" });
    expect(config.model).toBe("m");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ pointer: "/output", file: "/p/.skawld/config.json" });
  });

  test("unknown nested key → ConfigError with pointer", () => {
    expect(() => validate({ permissions: { mdoe: "yolo" } })).toThrow(/\/permissions\/mdoe/);
    expect(() => validate({ provider: { id: "anthropic", oops: 1 } })).toThrow(/\/provider\/oops/);
    expect(() => validate({ limits: { maxTries: 1 } })).toThrow(/\/limits\/maxTries/);
  });
});

describe("validateConfig — enums", () => {
  test("bad provider.id", () => {
    expect(() => validate({ provider: { id: "claude" } })).toThrow(/\/provider\/id/);
  });
  test("bad permissions.mode", () => {
    expect(() => validate({ permissions: { mode: "wild" } })).toThrow(/\/permissions\/mode/);
  });
  test("bad sessionStore.kind", () => {
    expect(() => validate({ sessionStore: { kind: "redis" } })).toThrow(/\/sessionStore\/kind/);
  });
});

describe("validateConfig — rules per kind", () => {
  test("missing decision", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "bash", pattern: "ls" }] } }))
      .toThrow(/\/permissions\/rules\/0\/decision/);
  });
  test("tool rule requires string tool", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "tool", tool: 1, decision: "allow" }] } }))
      .toThrow(/\/permissions\/rules\/0\/tool/);
  });
  test("path rule requires string[] paths", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "path", paths: "x", decision: "allow" }] } }))
      .toThrow(/\/permissions\/rules\/0\/paths/);
  });
  test("bad rule kind", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "net", decision: "allow" }] } }))
      .toThrow(/\/permissions\/rules\/0\/kind/);
  });
  test("malformed bash regex fails at validation", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "bash", pattern: { regex: "[" }, decision: "deny" }] } }))
      .toThrow(/\/permissions\/rules\/0\/pattern\/regex/);
  });
  test("bash pattern must be string or {regex}", () => {
    expect(() => validate({ permissions: { rules: [{ kind: "bash", pattern: 5, decision: "deny" }] } }))
      .toThrow(/\/permissions\/rules\/0\/pattern/);
  });
});

describe("validateConfig — limits bounds", () => {
  test("maxTurns must be integer ≥ 1", () => {
    expect(() => validate({ limits: { maxTurns: 0 } })).toThrow(/\/limits\/maxTurns/);
    expect(() => validate({ limits: { maxTurns: 1.5 } })).toThrow(/\/limits\/maxTurns/);
  });
  test("maxOutputTokens must be integer ≥ 1", () => {
    expect(() => validate({ limits: { maxOutputTokens: 0 } })).toThrow(/\/limits\/maxOutputTokens/);
  });
  test("maxRetries must be integer ≥ 0", () => {
    expect(() => validate({ limits: { maxRetries: -1 } })).toThrow(/\/limits\/maxRetries/);
    expect(validate({ limits: { maxRetries: 0 } }).config.limits?.maxRetries).toBe(0);
  });
});
