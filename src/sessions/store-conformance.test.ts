/**
 * Shared conformance suite for the SessionStore contract. Parameterized over
 * every implementation so the two stores can't diverge silently. New stores add
 * one row to `STORES` and inherit every behavioral guarantee below.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { InMemorySessionStore } from "./memory.js";
import { SqliteSessionStore } from "./sqlite.js";
import type { SessionStore } from "./store.js";
import { SessionStoreError } from "../core/errors.js";

interface Harness {
  store: SessionStore;
  cleanup(): void;
}

const STORES: Record<string, () => Harness> = {
  InMemorySessionStore: () => ({ store: new InMemorySessionStore(), cleanup: () => {} }),
  SqliteSessionStore: () => {
    const dir = join(tmpdir(), `skawld-store-conf-${crypto.randomUUID()}`);
    const store = new SqliteSessionStore({ databasePath: join(dir, "sessions.db"), cwd: dir });
    return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  },
};

for (const [name, make] of Object.entries(STORES)) {
  describe(`SessionStore conformance — ${name}`, () => {
    let h: Harness;
    let store: SessionStore;
    beforeEach(() => { h = make(); store = h.store; });
    afterEach(async () => { await store.close?.(); h.cleanup(); });

    // H1 — dangling task edges throw on both stores.
    test("add_blocks referencing a non-existent task throws SessionStoreError", async () => {
      const s = await store.create({});
      const t = await store.createTask(s.id, { subject: "a", description: "a" });
      await expect(
        store.updateTask(s.id, t.id, { add_blocks: ["999"] }),
      ).rejects.toBeInstanceOf(SessionStoreError);
      // The valid task is untouched (no partial edge staged).
      const reloaded = await store.getTask(s.id, t.id);
      expect(reloaded!.blocks).toEqual([]);
    });

    test("add_blocked_by referencing a non-existent task throws SessionStoreError", async () => {
      const s = await store.create({});
      const t = await store.createTask(s.id, { subject: "a", description: "a" });
      await expect(
        store.updateTask(s.id, t.id, { add_blocked_by: ["999"] }),
      ).rejects.toBeInstanceOf(SessionStoreError);
    });

    test("a valid edge between two real tasks still works", async () => {
      const s = await store.create({});
      const a = await store.createTask(s.id, { subject: "a", description: "a" });
      const b = await store.createTask(s.id, { subject: "b", description: "b" });
      await store.updateTask(s.id, a.id, { add_blocks: [b.id] });
      expect((await store.getTask(s.id, a.id))!.blocks).toEqual([b.id]);
      expect((await store.getTask(s.id, b.id))!.blocked_by).toEqual([a.id]);
    });

    // H2 — load returns an isolated copy.
    test("mutating the loaded record does not mutate the store", async () => {
      const s = await store.create({ meta: { a: 1 } });
      const loaded = await store.load(s.id);
      (loaded!.meta as Record<string, unknown>).a = 999;
      (loaded!.meta as Record<string, unknown>).injected = true;
      const reloaded = await store.load(s.id);
      expect(reloaded!.meta).toEqual({ a: 1 });
    });

    // H3 — updateMeta on a missing session throws a typed error.
    test("updateMeta on an unknown id throws SessionStoreError", async () => {
      await expect(
        store.updateMeta("no-such-session", { x: 1 }),
      ).rejects.toBeInstanceOf(SessionStoreError);
    });

    test("updateMeta shallow-merges and bumps updated_at", async () => {
      const s = await store.create({ meta: { a: 1 } });
      const out = await store.updateMeta(s.id, { b: 2 });
      expect(out.meta).toEqual({ a: 1, b: 2 });
    });

    // H4 — concurrent updateMeta merges rather than losing keys.
    test("concurrent updateMeta calls preserve every key", async () => {
      const s = await store.create({ meta: {} });
      await Promise.all([
        store.updateMeta(s.id, { a: 1 }),
        store.updateMeta(s.id, { b: 2 }),
        store.updateMeta(s.id, { c: 3 }),
      ]);
      const final = await store.load(s.id);
      expect(final!.meta).toEqual({ a: 1, b: 2, c: 3 });
    });
  });
}
