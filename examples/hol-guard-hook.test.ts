import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createHolGuardPreToolHook, guardSpawnEnv } from "./hol-guard-hook.js";

const ctx = () => ({
  session_id: "session-1",
  run_id: "run-1",
  cwd: "/tmp/project",
  signal: new AbortController().signal,
});

const input = (command = "git status") => ({
  tool_name: "Bash",
  tool_use_id: "tool-1",
  input: { command },
  summary: `Bash: ${command}`,
});

test("Guard executable PATH cannot be redirected by changing into a project cwd", () => {
  const knownAbsoluteDir = resolve("guard-bin");
  const env = guardSpawnEnv({
    PATH: [".", "./bin", knownAbsoluteDir, "node_modules/.bin"].join(delimiter),
    OTHER: "keep",
  });
  expect(env.PATH).toBe(knownAbsoluteDir);
  expect(env.OTHER).toBe("keep");
  expect(() => guardSpawnEnv({ PATH: ["bin", ".", ""].join(delimiter) }))
    .toThrow("hol-guard requires an absolute executable PATH");
  expect(() => guardSpawnEnv({ OTHER: "no-path" }))
    .toThrow("hol-guard requires an absolute executable PATH");
  // Windows can have a mixed-case Path key; the subprocess receives one canonical PATH.
  const mixedCase = guardSpawnEnv({ Path: knownAbsoluteDir });
  expect(mixedCase.PATH).toBe(knownAbsoluteDir);
  expect(Object.keys(mixedCase).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
});

test("absolute project PATH entries and symlinks cannot impersonate Guard", () => {
  const project = mkdtempSync(join(tmpdir(), "skawld-untrusted-worktree-"));
  const trusted = mkdtempSync(join(tmpdir(), "skawld-trusted-guard-bin-"));
  try {
    const projectBin = join(project, "node_modules", ".bin");
    mkdirSync(projectBin, { recursive: true });
    const entries = [projectBin];
    // An absolute symlink outside the worktree must be checked by real path.
    if (process.platform !== "win32") {
      const alias = join(trusted, "linked-worktree-bin");
      symlinkSync(projectBin, alias, "dir");
      entries.push(alias);
    }
    entries.push(trusted);
    const sanitized = guardSpawnEnv({ PATH: entries.join(delimiter) }, project);
    expect(sanitized.PATH).toBe(trusted);
    expect(() => guardSpawnEnv({ PATH: projectBin }, project))
      .toThrow("hol-guard requires an absolute executable PATH");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("rejects PATH executable symlinks into an untrusted worktree", () => {
  if (process.platform === "win32") return;
  const project = mkdtempSync(join(tmpdir(), "skawld-executable-symlink-project-"));
  const externalBin = mkdtempSync(join(tmpdir(), "skawld-executable-symlink-bin-"));
  try {
    mkdirSync(join(project, ".git"));
    const projectBinary = join(project, "hol-guard");
    writeFileSync(projectBinary, "#!/bin/sh\\nexit 0\\n");
    chmodSync(projectBinary, 0o755);
    symlinkSync(projectBinary, join(externalBin, "hol-guard"));
    expect(() => guardSpawnEnv({ PATH: externalBin }, project))
      .toThrow("hol-guard requires an absolute executable PATH");
    rmSync(join(externalBin, "hol-guard"));
    writeFileSync(join(externalBin, "hol-guard"), "#!/bin/sh\\nexit 0\\n");
    chmodSync(join(externalBin, "hol-guard"), 0o755);
    expect(guardSpawnEnv({ PATH: externalBin }, project).PATH)
      .toBe(realpathSync(externalBin));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(externalBin, { recursive: true, force: true });
  }
});

describe("HOL Guard PreToolUse example", () => {
  test("continues only on an authoritative allow", async () => {
    let received = "";
    const hook = createHolGuardPreToolHook(async (payload) => {
      received = payload;
      return JSON.stringify({
        policy_action: "allow",
        reason_code: "native_policy_allow",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      });
    });

    const runContext = { ...ctx(), cwd: "/tmp/active-worktree" };
    expect(await hook(input(), runContext)).toEqual({ action: "continue" });
    expect(JSON.parse(received)).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/tmp/active-worktree",
      tool_input: { command: "git status" },
    });
  });

  test("never continues on an unavailable or contradictory allow-shaped result", async () => {
    for (const stop of [
      { continue: false },
      { continue: "false" },
      { decision: "deny" },
      { decision: "review" },
      { decision: 0 },
      { reason_code: "native_hook_worker_unavailable" },
    ]) {
      const hook = createHolGuardPreToolHook(async () => JSON.stringify({
        policy_action: "allow",
        reason_code: "native_policy_allow",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
        ...stop,
      }));
      expect((await hook(input(), ctx()))?.action).toBe("deny");
    }
  });

  test("requires a positive native-exact reason for execution", async () => {
    for (const [reasonCode, expectedAction] of [
      ["native_exact_safe_command", "continue"],
      ["native_exact_introspection_command", "continue"],
      ["native_exact_review_required", "deny"],
      ["native_exact_worker_unavailable", "deny"],
    ] as const) {
      const hook = createHolGuardPreToolHook(async () => JSON.stringify({
        policy_action: "allow",
        reason_code: reasonCode,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      }));
      expect((await hook(input(), ctx()))?.action).toBe(expectedAction);
    }
  });

  test("preserves a Guard review as ask", async () => {
    const hook = createHolGuardPreToolHook(async () =>
      JSON.stringify({
        policy_action: "review",
        reason_code: "native_pre_tool_review",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Guard review required",
        },
      }),
    );

    expect(await hook(input("bun add example"), ctx())).toEqual({ action: "ask" });
  });

  test("denies an explicit Guard block", async () => {
    const hook = createHolGuardPreToolHook(async () =>
      JSON.stringify({
        policy_action: "block",
        reason_code: "policy_block",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Policy denied the command",
        },
      }),
    );

    expect(await hook(input("rm -rf /tmp/example"), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: Policy denied the command",
    });
  });

  test("denies an allow-shaped non-allow policy result", async () => {
    const hook = createHolGuardPreToolHook(async () =>
      JSON.stringify({
        policy_action: "warn",
        reason_code: "native_hook_worker_exception",
        reason: "Native review was unavailable.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      }),
    );

    expect(await hook(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: Native review was unavailable.",
    });
  });

  test("denies duplicate native hook verdict members, including escaped keys", async () => {
    const contradictory = [
      '{"policy_action":"block","policy_action":"allow","reason_code":"native_policy_allow","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
      '{"policy_action":"allow","reason_code":"native_policy_allow","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecision":"allow"}}',
      '{"policy_action":"allow","reason_code":"native_policy_allow","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"metadata":{"note":"deny","note":"allow"}}',
      '{"policy_action":"block","policy_\\u0061ction":"allow","reason_code":"native_policy_allow","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
    ];
    for (const output of contradictory) {
      const hook = createHolGuardPreToolHook(async () => output);
      expect(await hook(input(), ctx())).toEqual({
        action: "deny",
        reason: "HOL Guard: invalid hook JSON",
      });
    }
  });

  test("fails closed on malformed or unavailable Guard results", async () => {
    const malformed = createHolGuardPreToolHook(async () => "not json");
    const unavailable = createHolGuardPreToolHook(async () => {
      throw new Error("binary missing");
    });

    expect(await malformed(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: invalid hook JSON",
    });
    expect(await unavailable(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: binary missing",
    });
  });

  test("denies non-string optional reason fields without throwing", async () => {
    const hook = createHolGuardPreToolHook(async () => JSON.stringify({
      policy_action: "block",
      reason_code: "policy_block",
      reason: 99,
      systemMessage: { text: "not a string" },
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ["unexpected"],
      },
    }));
    expect(await hook(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: policy action block returned deny",
    });
  });

  test("fails closed on a wrong event or missing authority fields", async () => {
    const wrongEvent = createHolGuardPreToolHook(async () =>
      JSON.stringify({
        policy_action: "allow",
        reason_code: "native_policy_allow",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          permissionDecision: "allow",
        },
      }),
    );
    const missingReasonCode = createHolGuardPreToolHook(async () =>
      JSON.stringify({
        policy_action: "allow",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      }),
    );

    expect(await wrongEvent(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: unexpected hook response event",
    });
    expect(await missingReasonCode(input(), ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: hook response has no reason code",
    });
  });

  test("denies missing or malformed tool identity before running Guard", async () => {
    const hook = createHolGuardPreToolHook(async () => {
      throw new Error("Guard must not run without a tool identity");
    });
    const malformed = [
      undefined,
      null,
      {},
      { tool_name: null },
      { tool_name: "" },
      { tool_name: 42 },
    ];
    for (const event of malformed) {
      expect(await hook(event as unknown as Parameters<typeof hook>[0], ctx())).toEqual({
        action: "deny",
        reason: "HOL Guard: tool identity is missing",
      });
    }
  });

  test("denies a malformed Bash envelope instead of throwing", async () => {
    const hook = createHolGuardPreToolHook(async () => {
      throw new Error("Guard must not run for missing input");
    });
    const missingInput = { ...input(), input: undefined } as unknown as Parameters<typeof hook>[0];
    const nullInput = { ...input(), input: null } as unknown as Parameters<typeof hook>[0];
    const expected = { action: "deny", reason: "HOL Guard: Bash command is missing" };
    expect(await hook(missingInput, ctx())).toEqual(expected);
    expect(await hook(nullInput, ctx())).toEqual(expected);
  });

  test("fails closed when Bash input has no command", async () => {
    const hook = createHolGuardPreToolHook(async () => {
      throw new Error("runner should not be called");
    });
    const badInput = {
      tool_name: "Bash",
      tool_use_id: "tool-1",
      input: {},
      summary: "Bash",
    };

    expect(await hook(badInput, ctx())).toEqual({
      action: "deny",
      reason: "HOL Guard: Bash command is missing",
    });
  });
  test("handles an abort between launch and child listener registration", async () => {
    // Simulate cancellation after the first aborted check while spawn is
    // about to report ENOENT. The error event must have a listener attached.
    const emptyBin = mkdtempSync(join(tmpdir(), "skawld-guard-empty-bin-"));
    const workingDir = mkdtempSync(join(tmpdir(), "skawld-guard-worktree-"));
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin;
      let abortedReads = 0;
      const signal = {
        get aborted() { return ++abortedReads > 1; },
        addEventListener() {},
        removeEventListener() {},
      } as unknown as AbortSignal;
      const hook = createHolGuardPreToolHook();
      expect(await hook(input(), { ...ctx(), cwd: workingDir, signal })).toEqual({
        action: "deny",
        reason: "HOL Guard: hook request aborted",
      });
      // Let the failed spawn emit its error, which previously escaped unhandled.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(emptyBin, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test("denies an already-aborted request before launching Guard", async () => {
    const controller = new AbortController();
    controller.abort();
    const hook = createHolGuardPreToolHook();
    const result = await hook(input(), { ...ctx(), signal: controller.signal });
    expect(result).toEqual({
      action: "deny",
      reason: "HOL Guard: hook request aborted",
    });
  });

});


test("denies relative or missing Bash cwd before invoking Guard", async () => {
  let guardCalls = 0;
  const hook = createHolGuardPreToolHook(async () => {
    guardCalls++;
    return JSON.stringify({
      policy_action: "allow",
      reason_code: "native_policy_allow",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  for (const cwd of ["", ".", "./project", "relative/worktree"]) {
    expect(await hook(input(), { ...ctx(), cwd })).toEqual({
      action: "deny",
      reason: "HOL Guard: Bash cwd must be an absolute path",
    });
  }
  expect(guardCalls).toBe(0);
});

test("uses the effective Bash workspace when invoking Guard", async () => {
  const workspace = "/tmp/active-worktree";
  let passedCwd = "";
  let inspectedCwd = "";
  const hook = createHolGuardPreToolHook(async (payload, _signal, cwd) => {
    passedCwd = cwd;
    inspectedCwd = JSON.parse(payload).cwd;
    return JSON.stringify({
      policy_action: "allow",
      reason_code: "native_policy_allow",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  expect(await hook(input("git status"), { ...ctx(), cwd: workspace })).toEqual({
    action: "continue",
  });
  expect(passedCwd).toBe(workspace);
  expect(inspectedCwd).toBe(workspace);
});

test("project-owned alias to a trusted external directory is excluded from Guard PATH", () => {
  // Directory symlinks require special privileges on some Windows CI hosts.
  if (process.platform === "win32") return;
  const project = mkdtempSync(join(tmpdir(), "skawld-untrusted-alias-"));
  const trusted = mkdtempSync(join(tmpdir(), "skawld-trusted-guard-"));
  const outside = mkdtempSync(join(tmpdir(), "skawld-outside-alias-"));
  try {
    const projectAlias = join(project, "linked-external-bin");
    const outsideAlias = join(outside, "linked-trusted-bin");
    symlinkSync(trusted, projectAlias, "dir");
    symlinkSync(trusted, outsideAlias, "dir");
    const env = guardSpawnEnv({ PATH: [projectAlias, outsideAlias].join(delimiter) }, project);
    // Do not run a project-controlled symlink, even while it points outside.
    // A trusted external alias is canonicalized before the child is spawned.
    expect(env.PATH).toBe(realpathSync(trusted));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("rejects invalid UTF-8 from a real Guard process before allowing Bash", async () => {
  if (process.platform === "win32") return;
  const workspace = mkdtempSync(join(tmpdir(), "skawld-guard-utf8-project-"));
  const trustedBin = mkdtempSync(join(tmpdir(), "skawld-guard-utf8-bin-"));
  const binary = join(trustedBin, "hol-guard");
  const allowed = JSON.stringify({
    policy_action: "allow",
    reason_code: "native_policy_allow",
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    diagnostic: "ok",
  });
  const index = allowed.lastIndexOf("ok");
  const shell = [
    "#!/bin/sh",
    `printf '%s' '${allowed.slice(0, index)}'`,
    "printf '\\377'",
    `printf '%s' '${allowed.slice(index + 2)}'`,
  ].join("\n") + "\n";
  writeFileSync(binary, shell);
  chmodSync(binary, 0o755);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = [trustedBin, priorPath ?? ""].join(delimiter);
    const verdict = await createHolGuardPreToolHook()(
      input(),
      { ...ctx(), cwd: workspace },
    );
    expect(verdict).toEqual({
      action: "deny",
      reason: "HOL Guard: hook stdout is not valid UTF-8",
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(trustedBin, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});


test("denies a changed tool request after an asynchronous Guard allow", async () => {
  for (const changed of ["command", "nested", "cwd"]) {
    const event = { ...input(), input: { command: "git status", options: { mode: "safe" } } };
    const hookContext = { ...ctx(), cwd: "/tmp/project" };
    const hook = createHolGuardPreToolHook(async () => {
      if (changed === "command") event.input.command = "rm -rf build";
      else if (changed === "nested") event.input.options.mode = "unsafe";
      else hookContext.cwd = "/tmp/another-worktree";
      return JSON.stringify({
        policy_action: "allow",
        reason_code: "native_policy_allow",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      });
    });

    const result = await hook(event, hookContext);
    expect(result).toEqual({
      action: "deny",
      reason: "HOL Guard: Bash inputs changed during policy evaluation",
    });
  }
});


test("launcher-checkout PATH cannot impersonate Guard for another Bash worktree", () => {
  const launcher = mkdtempSync(join(tmpdir(), "skawld-guard-launch-"));
  const target = mkdtempSync(join(tmpdir(), "skawld-guard-bash-"));
  const trusted = mkdtempSync(join(tmpdir(), "skawld-guard-external-"));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(launcher, ".git"));
    mkdirSync(join(target, ".git"));
    const launcherBin = join(launcher, ".bin");
    const targetBin = join(target, ".bin");
    mkdirSync(launcherBin);
    mkdirSync(targetBin);
    const entries = [launcherBin, targetBin];
    if (process.platform !== "win32") {
      // A project-owned directory alias cannot launder the external bin.
      const launcherAlias = join(launcher, "alias-to-trusted");
      symlinkSync(trusted, launcherAlias, "dir");
      entries.push(launcherAlias);
    }
    entries.push(trusted);
    process.chdir(launcher);
    const env = guardSpawnEnv({ PATH: entries.join(delimiter) }, target);
    expect(env.PATH).toBe(realpathSync(trusted));
    expect(() => guardSpawnEnv({ PATH: launcherBin }, target))
      .toThrow("hol-guard requires an absolute executable PATH");
  } finally {
    process.chdir(originalCwd);
    rmSync(launcher, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});
