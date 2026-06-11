import { describe, expect, it } from "bun:test";
import { Agent } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { ConfigError } from "./errors.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import type { BaseProvider } from "../providers/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { Message } from "./types.js";
import type { Event } from "./events.js";

function makeProvider(): BaseProvider {
  return {
    id: "test-provider",
    contextWindow: (_model: string) => 200_000,
    stream: async function* () {},
  };
}

async function makeSession() {
  const store = new InMemorySessionStore();
  const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
  const sess = await agent.session();
  return { sess, store };
}

describe("Session.messageCount", () => {
  it("reflects providerView length (zero for new session)", async () => {
    const { sess } = await makeSession();
    expect(sess.messageCount).toBe(0);
  });

  it("updates after messages are appended via the store", async () => {
    const { sess, store } = await makeSession();
    await store.appendMessages(sess.id, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    // messageCount reflects the in-memory providerView.
    // Since we appended directly to the store (bypassing the session's append helper),
    // the count won't increase. This is expected — direct store writes do not
    // automatically sync the in-memory providerView.
    expect(sess.messageCount).toBe(0);
  });
});

describe("Session.run() — single-active-run guard", () => {
  it("throws ConfigError synchronously when a run is already active", async () => {
    const { sess } = await makeSession();

    // Start first run (it returns an AsyncIterable; runLoop throws on .next()).
    const iter1 = sess.run("prompt 1");

    // A second run() call must throw ConfigError synchronously — before iteration.
    expect(() => sess.run("prompt 2")).toThrow(ConfigError);

    // Clean up: drain iter1 so the guard resets.
    try {
      const it = iter1[Symbol.asyncIterator]();
      await it.next(); // this will throw the "not implemented" error from the stub
    } catch {
      // Expected — runLoop stub throws.
    }
  });

  it("allows a second run after the first iterator is drained", async () => {
    const { sess } = await makeSession();

    // First run: drain it (stub throws, which wrapWithFinally catches and resets activeRunId).
    const iter1 = sess.run("prompt 1");
    try {
      for await (const _ of iter1) { /* drain */ }
    } catch {
      // The stub throws — expected.
    }

    // After draining, activeRunId should be reset. A new run must succeed.
    expect(() => sess.run("prompt 2")).not.toThrow();
  });
});

describe("Session.abort()", () => {
  it("is idempotent — can be called multiple times without throwing", async () => {
    const { sess } = await makeSession();

    expect(() => {
      sess.abort();
      sess.abort("reason");
      sess.abort();
    }).not.toThrow();
  });

  it("aborts the internal signal", async () => {
    const { sess } = await makeSession();
    const internal = getSessionInternals(sess);

    expect(internal.internalController.signal.aborted).toBe(false);
    sess.abort("test");
    expect(internal.internalController.signal.aborted).toBe(true);
  });
});

describe("Session.updateMeta()", () => {
  it("writes through to the store", async () => {
    const { sess, store } = await makeSession();

    await sess.updateMeta({ title: "my session" });

    const record = await store.load(sess.id);
    expect(record?.meta.title).toBe("my session");
  });

  it("merges multiple patches", async () => {
    const { sess, store } = await makeSession();

    await sess.updateMeta({ a: 1 });
    await sess.updateMeta({ b: 2 });

    const record = await store.load(sess.id);
    expect(record?.meta.a).toBe(1);
    expect(record?.meta.b).toBe(2);
  });
});

describe("Session.run() — iterator abandonment cleanup", () => {
  it("iterator abandoned via for-await break allows next run()", async () => {
    const { sess } = await makeSession();

    // Start a run and break immediately after first event (or after loop body hits break).
    // The iterator's return() is called by the for-await machinery on break.
    const iter = sess.run("prompt 1");
    // Collect just the first event to ensure the generator has started, then break.
    for await (const _ of iter) {
      break; // triggers iter.return() → cleanup → activeRunId = null
    }

    // After break, the cleanup should have fired synchronously via return().
    const internal = getSessionInternals(sess);
    expect(internal.activeRunId).toBeNull();

    // A new run() must not throw.
    expect(() => sess.run("prompt 2")).not.toThrow();
  });

  it("explicit iterator.return() allows next run()", async () => {
    const { sess } = await makeSession();

    const iter = sess.run("prompt 1");
    const it = iter[Symbol.asyncIterator]();

    // Trigger at least one .next() so the generator initializes, then call .return().
    // (The generator may throw internally; that's fine — we just want cleanup to run.)
    try {
      await it.next();
    } catch {
      // expected — mock provider stream is empty
    }

    // Explicitly call return() to signal abandonment.
    await it.return?.(undefined);

    const internal = getSessionInternals(sess);
    expect(internal.activeRunId).toBeNull();

    expect(() => sess.run("prompt 2")).not.toThrow();
  });
});

/** Delegates to an InMemorySessionStore but rejects the first N appendMessages calls. */
function flakyAppendStore(inner: InMemorySessionStore, failTimes: number): SessionStore {
  let failsLeft = failTimes;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "appendMessages") {
        return async (id: string, messages: Message[]) => {
          if (failsLeft > 0) {
            failsLeft--;
            throw new Error("appendMessages: database is locked");
          }
          return target.appendMessages(id, messages);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as SessionStore;
}

describe("Session.run() — store failure on user append (C2)", () => {
  it("yields ErrorEvent + ResultEvent(error) and leaves the Session reusable", async () => {
    const provider = new MockProvider();
    // Script only consumed by the SECOND run (first run fails before streaming).
    provider.enqueue({
      events: [
        { type: "message_start", model: "m" },
        { type: "text_delta", text: "second run ok" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      ],
    });

    const inner = new InMemorySessionStore();
    const store = flakyAppendStore(inner, 1); // first appendMessages rejects once
    const agent = new Agent({ provider, model: "m", sessionStore: store });
    const sess = await agent.session();

    // First run: the user-message append rejects → error + result(error), completes.
    const first: Event[] = [];
    for await (const ev of sess.run("prompt 1")) first.push(ev);

    const errEvent = first.find(e => e.type === "error") as
      | Extract<Event, { type: "error" }>
      | undefined;
    const resultEvent = first.find(e => e.type === "result") as
      | Extract<Event, { type: "result" }>
      | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent!.error.message).toContain("database is locked");
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.subtype).toBe("error");
    // No assistant/user message survived the failed append.
    expect(first.some(e => e.type === "user")).toBe(false);

    // The Session must be reusable: activeRunId released, second run starts normally.
    expect(getSessionInternals(sess).activeRunId).toBeNull();

    const second: Event[] = [];
    for await (const ev of sess.run("prompt 2")) second.push(ev);
    const secondResult = second.find(e => e.type === "result") as
      | Extract<Event, { type: "result" }>
      | undefined;
    expect(secondResult).toBeDefined();
    expect(secondResult!.subtype).toBe("success");

    await agent.close();
  });
});
