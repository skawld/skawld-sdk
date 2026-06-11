/**
 * Merge multiple async generators into one, interleaving values in arrival
 * order with an optional concurrency cap. Port of Claude Code's
 * `utils/generators.ts → all()` (Promise.race-based). Caller is responsible
 * for cancelling source generators on early termination — typically via
 * AbortSignal threaded into the source's body.
 *
 * Used by the scheduler's parallel batch lane (see src/core/scheduler.ts).
 */

interface QueuedGenerator<T> {
  done: boolean;
  value: T | undefined;
  generator: AsyncGenerator<T, void>;
  promise: Promise<QueuedGenerator<T>>;
}

export async function* mergeAsyncGenerators<T>(
  generators: AsyncGenerator<T, void>[],
  concurrencyCap: number = Infinity,
): AsyncGenerator<T, void> {
  // Empty input completes immediately.
  if (generators.length === 0) return;

  // Clamp cap to >= 1 — a 0-cap would deadlock.
  const cap = Math.max(1, concurrencyCap);

  const next = (generator: AsyncGenerator<T, void>): Promise<QueuedGenerator<T>> => {
    const promise: Promise<QueuedGenerator<T>> = generator.next().then(
      ({ done, value }) => ({
        // Carry the done flag explicitly — never infer it from the value, so a
        // generator that yields `undefined` is delivered rather than dropped.
        done: !!done,
        value: done ? undefined : (value as T),
        generator,
        promise,
      }),
    );
    return promise;
  };

  const waiting = [...generators];
  const promises = new Set<Promise<QueuedGenerator<T>>>();
  // Generators we've started and not yet exhausted. On early exit (consumer
  // break, or a sibling threw) we return() these so abandoned generators run
  // their finally blocks instead of being left parked forever.
  const active = new Set<AsyncGenerator<T, void>>();

  const start = (generator: AsyncGenerator<T, void>) => {
    active.add(generator);
    promises.add(next(generator));
  };

  try {
    while (promises.size < cap && waiting.length > 0) {
      start(waiting.shift()!);
    }

    while (promises.size > 0) {
      const { done, value, generator, promise } = await Promise.race(promises);
      promises.delete(promise);
      if (!done) {
        promises.add(next(generator));
        yield value as T;
      } else {
        active.delete(generator);
        if (waiting.length > 0) start(waiting.shift()!);
      }
    }
  } finally {
    // Best-effort cancellation of anything still running; ignore return() errors.
    for (const g of active) {
      void g.return(undefined).catch(() => {});
    }
  }
}

/**
 * Resolve the default tool-call concurrency cap at Agent construction time.
 * Reads `SKAWLD_MAX_TOOL_CONCURRENCY` (base-10 int); falls back to 10 on
 * absent, non-numeric, or <= 0 values. Matches Claude Code's default of 10.
 */
export function getDefaultToolConcurrency(): number {
  const raw = process.env.SKAWLD_MAX_TOOL_CONCURRENCY;
  if (raw === undefined) return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
