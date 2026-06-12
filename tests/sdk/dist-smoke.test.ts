/**
 * SDK surface smoke tests — dist layer.
 *
 * Imports ONLY the published specifiers (`@skawld/agent-sdk`, `@skawld/agent-sdk/providers`, ...) so
 * it validates the package.json `exports` map and the emitted output resolve
 * correctly through the package self-reference.
 *
 * Gated on the SKAWLD_DIST_TEST env var (set only by `bun run test:dist`, which
 * builds first). A plain `bun test` leaves it unset and skips this suite — even
 * if a stale `dist/` from an earlier build is present, which an existence check
 * alone would wrongly run against. Imports are dynamic (inside the guarded
 * block) so module load never fails when the suite is skipped.
 */

import { describe, expect, test } from "bun:test";

const distTestEnabled = !!process.env.SKAWLD_DIST_TEST;

describe.skipIf(!distTestEnabled)("SDK surface — dist layer (published specifiers)", () => {
  test("main entry exports resolve from dist", async () => {
    const sdk = await import("@skawld/agent-sdk");
    expect(typeof sdk.Agent).toBe("function");
    expect(typeof sdk.Session).toBe("function");
    expect(typeof sdk.defaultTools).toBe("function");
    expect(typeof sdk.SkawldError).toBe("function");
    expect(typeof sdk.loadConfig).toBe("function");
    // defaultTools() builds a usable registry.
    const names = sdk.defaultTools().list().map((t: { name: string }) => t.name);
    expect(names).toContain("Read");
  });

  test("providers subpath resolves from dist", async () => {
    const providers = await import("@skawld/agent-sdk/providers");
    expect(typeof providers.AnthropicProvider).toBe("function");
    expect(typeof providers.OpenAIChatCompletionsProvider).toBe("function");
    expect(typeof providers.OpenAIResponsesProvider).toBe("function");
    expect(typeof providers.BaseProvider).toBe("function");
    expect(typeof providers.withRetry).toBe("function");
    // mapOpenAIError was pruned from the public surface.
    expect((providers as Record<string, unknown>).mapOpenAIError).toBeUndefined();
  });

  test("tools subpath resolves from dist", async () => {
    const tools = await import("@skawld/agent-sdk/tools");
    expect(typeof tools.ToolRegistry).toBe("function");
    expect(typeof tools.defaultTools).toBe("function");
    expect(typeof tools.ReadTool).toBe("function");
    expect(typeof tools.FileReadTracker).toBe("function");
  });

  test("sessions subpath resolves from dist", async () => {
    const sessions = await import("@skawld/agent-sdk/sessions");
    expect(typeof sessions.SqliteSessionStore).toBe("function");
    expect(typeof sessions.InMemorySessionStore).toBe("function");
  });

  test("permissions subpath resolves from dist", async () => {
    const permissions = await import("@skawld/agent-sdk/permissions");
    expect(typeof permissions.PermissionEngine).toBe("function");
  });
});
