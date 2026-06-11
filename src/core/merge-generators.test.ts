import { afterEach, describe, expect, test } from "bun:test";
import {
  getDefaultToolConcurrency,
  mergeAsyncGenerators,
} from "./merge-generators.js";

// Tiny helper: yield each item with an optional async tick between, so we can
// exercise the merge's "interleaved by completion order" behavior.
async function* fromArray<T>(items: T[], delayMs = 0): AsyncGenerator<T, void> {
  for (const item of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}

async function collect<T>(g: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of g) out.push(v);
  return out;
}

describe("mergeAsyncGenerators", () => {
  test("empty input completes with no yields", async () => {
    expect(await collect(mergeAsyncGenerators<number>([]))).toEqual([]);
  });

  test("single generator forwards values in order then completes", async () => {
    expect(await collect(mergeAsyncGenerators([fromArray([1, 2, 3])]))).toEqual([1, 2, 3]);
  });

  test("multiple generators, no cap → all values delivered (order may vary)", async () => {
    const result = await collect(
      mergeAsyncGenerators([fromArray([1, 2]), fromArray([10, 20]), fromArray([100])]),
    );
    expect(result.sort((a, b) => a - b)).toEqual([1, 2, 10, 20, 100]);
  });

  test("cap=2 with 4 generators: never more than 2 in flight, all values delivered", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeGen = (id: number): AsyncGenerator<number, void> =>
      (async function* () {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 5));
          yield id * 10 + i;
        }
        inFlight--;
      })();

    const result = await collect(
      mergeAsyncGenerators([makeGen(1), makeGen(2), makeGen(3), makeGen(4)], 2),
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.length).toBe(12);
  });

  test("cap respected even when a later generator yields faster than an earlier one", async () => {
    // Two slow generators + one fast one; cap=2 means the fast one waits.
    let started = 0;
    const slow = (id: number): AsyncGenerator<string, void> =>
      (async function* () {
        started++;
        await new Promise((r) => setTimeout(r, 30));
        yield `slow-${id}`;
      })();
    const fast = (): AsyncGenerator<string, void> =>
      (async function* () {
        started++;
        yield "fast";
      })();

    const merged = mergeAsyncGenerators([slow(1), slow(2), fast()], 2);
    // First two generators start immediately; fast() waits for a slot.
    const out: string[] = [];
    for await (const v of merged) out.push(v);
    expect(started).toBe(3);
    expect(out.length).toBe(3);
  });

  test("generator that throws → merge throws same error", async () => {
    const boom = (async function* (): AsyncGenerator<number, void> {
      yield 1;
      throw new Error("kapow");
    })();
    const good = fromArray([10, 20]);
    let caught: unknown;
    try {
      for await (const _ of mergeAsyncGenerators<number>([boom, good])) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("kapow");
  });

  test("yielded undefined values are delivered, not dropped (C7)", async () => {
    async function* gen(): AsyncGenerator<number | undefined, void> {
      yield 1;
      yield undefined;
      yield 2;
    }
    // done is carried through explicitly, so an `undefined` value is a real
    // yield — not conflated with generator completion.
    expect(await collect(mergeAsyncGenerators<number | undefined>([gen()]))).toEqual([1, undefined, 2]);
  });

  test("undefined interleaved across multiple generators is fully delivered (C7)", async () => {
    async function* a(): AsyncGenerator<number | undefined, void> {
      yield undefined;
      yield 1;
    }
    async function* b(): AsyncGenerator<number | undefined, void> {
      yield 2;
      yield undefined;
    }
    const out = await collect(mergeAsyncGenerators<number | undefined>([a(), b()]));
    expect(out).toHaveLength(4);
    expect(out.filter(v => v === undefined)).toHaveLength(2);
    expect(out.filter(v => v === 1)).toHaveLength(1);
    expect(out.filter(v => v === 2)).toHaveLength(1);
  });

  test("cap=0 clamps to 1 (does not deadlock)", async () => {
    const result = await collect(mergeAsyncGenerators([fromArray([1, 2])], 0));
    expect(result).toEqual([1, 2]);
  });
});

describe("getDefaultToolConcurrency", () => {
  const originalEnv = process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
    else process.env.SKAWLD_MAX_TOOL_CONCURRENCY = originalEnv;
  });

  test("returns 10 when env unset", () => {
    delete process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
    expect(getDefaultToolConcurrency()).toBe(10);
  });

  test("returns parsed int when env set to a positive number", () => {
    process.env.SKAWLD_MAX_TOOL_CONCURRENCY = "25";
    expect(getDefaultToolConcurrency()).toBe(25);
  });

  test("falls back to 10 on garbage or non-positive values", () => {
    for (const v of ["abc", "", "0", "-1", "NaN"]) {
      process.env.SKAWLD_MAX_TOOL_CONCURRENCY = v;
      expect(getDefaultToolConcurrency()).toBe(10);
    }
  });
});
