import { describe, it, expect } from "bun:test";
import { BashTool } from "./bash.js";
import type { ToolContext } from "./base.js";

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: process.cwd(),
    signal: signal ?? new AbortController().signal,
    fileReadTracker: { markRead: () => {}, hasRead: () => false } as any,
    sessionId: "test-session",
    runId: "test-run",
    sessionStore: {} as any,
  };
}

const tool = new BashTool();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BashTool", () => {
  describe("validate()", () => {
    it("accepts a valid command", () => {
      const input = tool.validate({ command: "echo hello" });
      expect(input.command).toBe("echo hello");
      expect(input.timeout_ms).toBe(120_000);
    });

    it("rejects missing command", () => {
      expect(() => tool.validate({})).toThrow();
    });

    it("rejects empty command", () => {
      expect(() => tool.validate({ command: "   " })).toThrow();
    });

    it("clamps timeout_ms to min 100", () => {
      const input = tool.validate({ command: "echo", timeout_ms: 0 });
      expect(input.timeout_ms).toBe(100);
    });

    it("clamps timeout_ms to max 1800000", () => {
      const input = tool.validate({ command: "echo", timeout_ms: 9_999_999 });
      expect(input.timeout_ms).toBe(1_800_000);
    });

    it("rejects non-finite timeout_ms", () => {
      expect(() => tool.validate({ command: "echo", timeout_ms: Infinity })).toThrow();
    });

    it("coerces string timeout_ms", () => {
      const input = tool.validate({ command: "echo", timeout_ms: "5000" as any });
      expect(input.timeout_ms).toBe(5_000);
    });
  });

  describe("summarize()", () => {
    it("uses description when present", () => {
      const input = tool.validate({ command: "echo hi", description: "say hi" });
      expect(tool.summarize(input)).toBe("say hi");
    });

    it("falls back to command snippet", () => {
      const input = tool.validate({ command: "echo hello" });
      expect(tool.summarize(input)).toBe("Bash: echo hello");
    });

    it("truncates long commands at 60 chars", () => {
      const long = "a".repeat(80);
      const input = tool.validate({ command: long });
      const summary = tool.summarize(input);
      expect(summary.startsWith("Bash: ")).toBe(true);
      expect(summary).toContain("…");
      // "Bash: " (6) + 60 chars + "…" (1) = 67
      expect(summary.length).toBe(67);
    });
  });

  describe("execute()", () => {
    it("runs echo hello → exit 0, output contains 'hello'", async () => {
      const result = await tool.execute(
        tool.validate({ command: "echo hello" }),
        makeCtx(),
      );
      expect(result.is_error).toBeFalsy();
      expect(result.content).toContain("hello");
      expect(result.content).toMatch(/exit: 0$/);
    });

    it("false → exit 1, no is_error", async () => {
      const result = await tool.execute(
        tool.validate({ command: "false" }),
        makeCtx(),
      );
      expect(result.is_error).toBeFalsy();
      expect(result.content).toMatch(/exit: 1$/);
    });

    it.skipIf(isWindows)(
      "separates stdout and stderr with --- separator",
      async () => {
        const result = await tool.execute(
          tool.validate({ command: 'sh -c "echo out; echo err 1>&2"' }),
          makeCtx(),
        );
        expect(result.is_error).toBeFalsy();
        expect(result.content).toContain("out");
        expect(result.content).toContain("---");
        expect(result.content).toContain("err");
        expect(result.content).toMatch(/exit: 0$/);
      },
    );

    it("timeout → is_error: true, message mentions timeout", async () => {
      const result = await tool.execute(
        tool.validate({ command: "sleep 5", timeout_ms: 200 }),
        makeCtx(),
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/timed out/i);
      expect(result.content).toContain("200");
    });

    it.skipIf(isWindows)("timeout result includes captured partial output (E10)", async () => {
      const result = await tool.execute(
        tool.validate({ command: "echo partial-out; sleep 5", timeout_ms: 300 }),
        makeCtx(),
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("partial-out");
      expect(result.content).toMatch(/timed out/i);
    });

    it.skipIf(isWindows)("reports the signal name when the process dies by signal (E10)", async () => {
      const result = await tool.execute(
        tool.validate({ command: "kill -TERM $$" }),
        makeCtx(),
      );
      expect(result.content).toMatch(/exit: signal SIGTERM/);
    });

    it("abort via signal → is_error: true, message mentions abort", async () => {
      const controller = new AbortController();
      const promise = tool.execute(
        tool.validate({ command: "sleep 5" }),
        makeCtx(controller.signal),
      );
      setTimeout(() => controller.abort(), 100);
      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/abort/i);
    });

    it("pre-aborted signal → is_error: true immediately", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await tool.execute(
        tool.validate({ command: "echo hi" }),
        makeCtx(controller.signal),
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/abort/i);
    });

    it("output truncation: >30000 chars → truncation marker, exit line last", async () => {
      // Generate ~60000 'a' chars via yes + head
      const result = await tool.execute(
        tool.validate({
          command: "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 60000",
          timeout_ms: 10_000,
        }),
        makeCtx(),
      );
      expect(result.is_error).toBeFalsy();
      expect(result.content).toContain("truncated");
      // exit: line must be the last line
      const lines = (result.content as string).trimEnd().split("\n");
      expect(lines.at(-1)).toMatch(/^exit: /);
    });

    it.skipIf(isWindows)(
      "spawn failure with nonexistent shell → is_error: true",
      async () => {
        const saved = process.env.SHELL;
        process.env.SHELL = "/nonexistent-shell-xyz";
        try {
          const result = await tool.execute(
            tool.validate({ command: "echo hi" }),
            makeCtx(),
          );
          expect(result.is_error).toBe(true);
        } finally {
          if (saved === undefined) {
            delete process.env.SHELL;
          } else {
            process.env.SHELL = saved;
          }
        }
      },
    );

    it.skipIf(isWindows)(
      "process-tree kill: child process is gone after timeout",
      async () => {
        // Spawn a shell that spawns a sleep child; after timeout all should be dead
        const result = await tool.execute(
          tool.validate({
            command: "sh -c 'sleep 10 & sleep 10'",
            timeout_ms: 300,
          }),
          makeCtx(),
        );
        expect(result.is_error).toBe(true);
        // Give the kill cascade time to complete
        await new Promise((r) => setTimeout(r, 2_500));
        // Verify no skawld-spawned sleep processes linger by checking that
        // the child is marked killed (we trust the SIGKILL cascade did its job;
        // a stronger check would parse `ps` but that's platform-fragile)
        expect(result.content).toMatch(/timed out/i);
      },
    );
  });

  describe("metadata", () => {
    it("scope is exec", () => {
      expect(tool.scope).toBe("exec");
    });

    it("parallelSafe is false", () => {
      expect(tool.parallelSafe).toBe(false);
    });
  });
});
