import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError } from "../core/errors.js";
import { loadConfig } from "./loader.js";

let root: string;
let home: string;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "skawld-cfg-"));
  home = path.join(root, "home");
  projectDir = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeUser(obj: unknown) {
  const p = path.join(home, ".skawld", "config.json");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function writeProject(obj: unknown) {
  const p = path.join(projectDir, ".skawld", "config.json");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function load(extra: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  // Isolate the user config from the real ~/.skawld by pinning HOME in the snapshot.
  return loadConfig({ cwd: projectDir, ...extra, env: { HOME: home, ...extra.env } });
}

describe("loadConfig — files", () => {
  test("missing files are OK (equivalent to {})", async () => {
    const { config, sources } = await load();
    expect(config).toEqual({});
    expect(sources).toEqual([{ source: "default" }]);
  });

  test("malformed JSON throws ConfigError naming the file", async () => {
    const p = path.join(projectDir, ".skawld", "config.json");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "{ bad json");
    await expect(load()).rejects.toThrow(ConfigError);
    await expect(load()).rejects.toThrow(p);
  });
});

describe("loadConfig — precedence", () => {
  test("project overrides user for scalar keys", async () => {
    writeUser({ model: "user-model" });
    writeProject({ model: "project-model" });
    const { config } = await load();
    expect(config.model).toBe("project-model");
  });

  test("env overrides project; override beats env", async () => {
    writeProject({ model: "project-model" });
    const viaEnv = await load({ env: { SKAWLD_MODEL: "env-model" } });
    expect(viaEnv.config.model).toBe("env-model");
    const viaOverride = await load({ env: { SKAWLD_MODEL: "env-model" }, overrides: { model: "override-model" } });
    expect(viaOverride.config.model).toBe("override-model");
  });

  test("limits shallow-merge across sources", async () => {
    writeUser({ limits: { maxTurns: 10, maxRetries: 2 } });
    writeProject({ limits: { maxTurns: 20 } });
    const { config } = await load();
    expect(config.limits).toEqual({ maxTurns: 20, maxRetries: 2 });
  });

  test("ignoreUserConfig skips the user file", async () => {
    writeUser({ model: "user-model" });
    const { config, sources } = await load({ ignoreUserConfig: true });
    expect(config.model).toBeUndefined();
    expect(sources.some((s) => s.source === "user")).toBe(false);
  });
});

describe("loadConfig — rule concatenation order", () => {
  test("user → project → override, with allows accepted", async () => {
    writeUser({ permissions: { rules: [{ kind: "bash", pattern: "ls", decision: "allow" }] } });
    writeProject({ permissions: { rules: [{ kind: "bash", pattern: "git status", decision: "allow" }] } });
    const { config } = await load({
      acceptProjectConfig: true,
      overrides: { permissions: { rules: [{ kind: "bash", pattern: "npm test", decision: "allow" }] } },
    });
    const patterns = config.permissions!.rules!.map((r) => (r.kind === "bash" ? r.pattern : null));
    expect(patterns).toEqual(["ls", "git status", "npm test"]);
  });
});

describe("loadConfig — discriminated unions", () => {
  test("provider replaced whole when id changes (no apiKey carryover)", async () => {
    writeUser({ provider: { id: "anthropic", apiKey: "sk-ant" } });
    writeProject({ provider: { id: "openai-chat" } });
    const { config } = await load();
    expect(config.provider).toEqual({ id: "openai-chat" });
  });

  test("provider shallow-merges when id is the same", async () => {
    writeUser({ provider: { id: "anthropic", apiKey: "sk-ant" } });
    writeProject({ provider: { id: "anthropic", baseURL: "https://proxy" } });
    const { config } = await load();
    expect(config.provider).toEqual({ id: "anthropic", apiKey: "sk-ant", baseURL: "https://proxy" });
  });

  test("env applies provider vars as one unit (baseURL merges onto same id)", async () => {
    writeUser({ provider: { id: "anthropic", apiKey: "sk-ant" } });
    const { config } = await load({ env: { SKAWLD_BASE_URL: "https://proxy" } });
    expect(config.provider).toEqual({ id: "anthropic", apiKey: "sk-ant", baseURL: "https://proxy" });
  });

  test("env provider id change replaces (drops apiKey), even with baseURL", async () => {
    writeUser({ provider: { id: "anthropic", apiKey: "sk-ant" } });
    const { config } = await load({ env: { SKAWLD_PROVIDER: "openai-chat", SKAWLD_BASE_URL: "https://proxy" } });
    expect(config.provider).toEqual({ id: "openai-chat", baseURL: "https://proxy" });
  });

  test("sessionStore memory override drops stale databasePath", async () => {
    writeUser({ sessionStore: { kind: "sqlite", databasePath: "./old.db" } });
    const { config } = await load({ overrides: { sessionStore: { kind: "memory" } } });
    expect(config.sessionStore).toEqual({ kind: "memory" });
  });
});

describe("loadConfig — env vars", () => {
  test("maps every documented var", async () => {
    const { config } = await load({
      env: {
        SKAWLD_MODEL: "m",
        SKAWLD_PROVIDER: "openai-responses",
        SKAWLD_BASE_URL: "https://b",
        SKAWLD_PERMISSION_MODE: "acceptEdits",
        SKAWLD_MAX_TURNS: "42",
        SKAWLD_DB_PATH: "/db.sqlite",
      },
    });
    expect(config.model).toBe("m");
    expect(config.provider).toEqual({ id: "openai-responses", baseURL: "https://b" });
    expect(config.permissions?.mode).toBe("acceptEdits");
    expect(config.limits?.maxTurns).toBe(42);
    expect(config.sessionStore).toEqual({ kind: "sqlite", databasePath: "/db.sqlite" });
  });

  test("non-integer SKAWLD_MAX_TURNS → ConfigError naming the var", async () => {
    await expect(load({ env: { SKAWLD_MAX_TURNS: "abc" } })).rejects.toThrow(/SKAWLD_MAX_TURNS/);
  });

  test("invalid SKAWLD_PROVIDER → ConfigError naming the var", async () => {
    await expect(load({ env: { SKAWLD_PROVIDER: "claude" } })).rejects.toThrow(/SKAWLD_PROVIDER/);
  });

  test("SKAWLD_CONFIG redirects the project file location and is gated", async () => {
    const alt = path.join(root, "alt-config.json");
    writeFileSync(alt, JSON.stringify({ model: "alt" }));
    const { config, sources } = await load({ env: { SKAWLD_CONFIG: alt } });
    expect(config.model).toBe("alt");
    expect(sources.find((s) => s.source === "project")?.path).toBe(alt);
  });
});

describe("loadConfig — systemPromptFile resolution", () => {
  test("project relative path resolves against the project .skawld dir", async () => {
    const p = writeProject({ systemPromptFile: "./instructions.md" });
    const { config } = await load();
    expect(config.systemPromptFile).toBe(path.resolve(path.dirname(p), "instructions.md"));
    expect(path.isAbsolute(config.systemPromptFile!)).toBe(true);
  });

  test("user relative path resolves against the user .skawld dir", async () => {
    const p = writeUser({ systemPromptFile: "./u.md" });
    const { config } = await load();
    expect(config.systemPromptFile).toBe(path.resolve(path.dirname(p), "u.md"));
  });

  test("env path resolves against cwd", async () => {
    const { config } = await load({ env: { SKAWLD_SYSTEM_PROMPT_FILE: "./e.md" } });
    expect(config.systemPromptFile).toBe(path.resolve(projectDir, "e.md"));
  });

  test("absolute paths pass through unchanged", async () => {
    writeProject({ systemPromptFile: "/abs/i.md" });
    const { config } = await load();
    expect(config.systemPromptFile).toBe("/abs/i.md");
  });

  test("systemPrompt shadows systemPromptFile with a warning", async () => {
    writeUser({ systemPromptFile: "./u.md" });
    writeProject({ systemPrompt: "inline" });
    const { config, warnings } = await load();
    expect(config.systemPrompt).toBe("inline");
    expect(config.systemPromptFile).toBeDefined();
    expect(warnings.some((w) => w.pointer === "/systemPromptFile")).toBe(true);
  });
});

describe("loadConfig — warnings", () => {
  test("unknown top-level key warns but loads", async () => {
    writeProject({ output: "x", model: "m" });
    const { config, warnings } = await load();
    expect(config.model).toBe("m");
    expect(warnings.some((w) => w.pointer === "/output")).toBe(true);
  });

  test("apiKey on disk warns (user and project), value never leaked", async () => {
    writeUser({ provider: { id: "anthropic", apiKey: "sk-secret" } });
    const { warnings } = await load();
    const w = warnings.find((x) => x.pointer === "/provider/apiKey");
    expect(w).toBeDefined();
    expect(w!.message).not.toContain("sk-secret");
  });
});

describe("loadConfig — untrusted project gate", () => {
  test("yolo mode in project file is gated", async () => {
    writeProject({ permissions: { mode: "yolo" } });
    await expect(load()).rejects.toThrow(/\/permissions\/mode/);
  });

  test("acceptEdits mode in project file is gated", async () => {
    writeProject({ permissions: { mode: "acceptEdits" } });
    await expect(load()).rejects.toThrow(ConfigError);
  });

  test("allow rule of each kind trips the gate and lists pointers", async () => {
    writeProject({
      permissions: {
        rules: [
          { kind: "bash", pattern: "ls", decision: "deny" },
          { kind: "tool", tool: "Bash", decision: "allow" },
          { kind: "path", paths: ["**"], decision: "allow" },
        ],
      },
    });
    await expect(load()).rejects.toThrow(/\/permissions\/rules\/1.*\/permissions\/rules\/2/s);
  });

  test("deny rules and default mode never trip the gate", async () => {
    writeProject({ permissions: { mode: "default", rules: [{ kind: "bash", pattern: { regex: "rm" }, decision: "deny" }] } });
    const { config } = await load();
    expect(config.permissions?.rules).toHaveLength(1);
  });

  test("acceptProjectConfig: true bypasses the gate", async () => {
    writeProject({ permissions: { mode: "yolo", rules: [{ kind: "bash", pattern: "ls", decision: "allow" }] } });
    const { config } = await load({ acceptProjectConfig: true });
    expect(config.permissions?.mode).toBe("yolo");
  });

  test("permissive USER config is never gated", async () => {
    writeUser({ permissions: { mode: "yolo", rules: [{ kind: "bash", pattern: "ls", decision: "allow" }] } });
    const { config } = await load();
    expect(config.permissions?.mode).toBe("yolo");
  });

  test("env permissive mode is never gated", async () => {
    const { config } = await load({ env: { SKAWLD_PERMISSION_MODE: "yolo" } });
    expect(config.permissions?.mode).toBe("yolo");
  });
});
