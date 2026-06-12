import { describe, expect, it } from "bun:test";
import {
  AbortError,
  AuthError,
  ConfigError,
  ProviderError,
  RateLimitError,
} from "../core/errors.js";
import { withRetry, withRetryableStream } from "./retry.js";

const fastOpts = {
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 5,
  jitter: 0,
};

describe("withRetry", () => {
  it("returns on first success without retry", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      fastOpts,
      new AbortController().signal,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new ProviderError("flaky", { status: 502, retryable: true });
        }
        return calls;
      },
      fastOpts,
      new AbortController().signal,
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  it("throws after maxAttempts retryable failures", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("nope", { status: 502, retryable: true });
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(fastOpts.maxAttempts);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new AuthError("nope");
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls).toBe(1);
  });

  it("rethrows non-SkawldError without retry", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("honors RateLimitError.retry_after_seconds without clamping up to maxDelayMs", async () => {
    let calls = 0;
    const start = Date.now();
    // 10ms exceeds maxDelayMs=5ms but is honored verbatim (no clamp-down).
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new RateLimitError("slow", { retry_after_seconds: 0.01 });
        }
        return "ok";
      },
      fastOpts,
      new AbortController().signal,
    );
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(200);
  });

  it("fails fast when retry_after exceeds the hard cap", async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RateLimitError("slow", { retry_after_seconds: 200 });
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("aborts mid-backoff via signal", async () => {
    const ctrl = new AbortController();
    const slowOpts = {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitter: 0,
    };
    setTimeout(() => ctrl.abort(), 10);
    await expect(
      withRetry(
        async () => {
          throw new ProviderError("flaky", { status: 502, retryable: true });
        },
        slowOpts,
        ctrl.signal,
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("throws AbortError immediately when signal already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      withRetry(async () => "never", fastOpts, ctrl.signal),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("rejects invalid maxAttempts before running the callback", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return "never";
        },
        { ...fastOpts, maxAttempts: 0 },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toBe(0);
  });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("withRetryableStream", () => {
  it("retries pre-output retryable errors and eventually yields items", async () => {
    let calls = 0;
    const result = await collect(
      withRetryableStream(
        () => (async function* () {
          calls++;
          if (calls < 3) {
            throw new ProviderError("flaky", { status: 502, retryable: true });
          }
          yield "ok";
        })(),
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
        new AbortController().signal,
      ),
    );

    expect(result).toEqual(["ok"]);
    expect(calls).toBe(3);
  });

  it("treats maxRetries as retries after the first attempt", async () => {
    let calls = 0;
    await expect(
      collect(
        withRetryableStream(
          () => (async function* () {
            calls++;
            throw new ProviderError("nope", { status: 502, retryable: true });
          })(),
          { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
          new AbortController().signal,
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(3);
  });

  it("rejects invalid maxRetries before opening a stream", async () => {
    let calls = 0;
    await expect(
      collect(
        withRetryableStream(
          () => (async function* () {
            calls++;
            yield "never";
          })(),
          { maxRetries: -1 },
          new AbortController().signal,
        ),
      ),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toBe(0);
  });

  it("honors RateLimitError.retry_after_seconds before retrying", async () => {
    let calls = 0;
    const start = Date.now();
    await collect(
      withRetryableStream(
        () => (async function* () {
          calls++;
          if (calls === 1) {
            throw new RateLimitError("slow", { retry_after_seconds: 0.01 });
          }
          yield "ok";
        })(),
        { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
        new AbortController().signal,
      ),
    );
    const elapsed = Date.now() - start;

    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(200);
  });

  it("does not retry non-retryable stream errors", async () => {
    let calls = 0;
    await expect(
      collect(
        withRetryableStream(
          () => (async function* () {
            calls++;
            throw new AuthError("nope");
          })(),
          { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
          new AbortController().signal,
        ),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls).toBe(1);
  });

  it("does not retry after the first item has been yielded", async () => {
    let calls = 0;
    const seen: string[] = [];

    await expect(
      (async () => {
        for await (const item of withRetryableStream(
          () => (async function* () {
            calls++;
            yield "first";
            throw new ProviderError("mid-stream", { status: 502, retryable: true });
          })(),
          { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
          new AbortController().signal,
        )) {
          seen.push(item);
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(seen).toEqual(["first"]);
    expect(calls).toBe(1);
  });

  it("buffers initial non-committing items across retries", async () => {
    let calls = 0;
    const result = await collect(
      withRetryableStream(
        () => (async function* () {
          calls++;
          yield "start";
          if (calls === 1) {
            throw new ProviderError("before-output", { status: 502, retryable: true });
          }
          yield "content";
        })(),
        {
          maxRetries: 1,
          baseDelayMs: 1,
          maxDelayMs: 5,
          jitter: 0,
          shouldCommit: (item) => item !== "start",
        },
        new AbortController().signal,
      ),
    );

    expect(result).toEqual(["start", "content"]);
    expect(calls).toBe(2);
  });

  it("aborts during stream backoff", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);

    await expect(
      collect(
        withRetryableStream(
          () => (async function* () {
            throw new ProviderError("flaky", { status: 502, retryable: true });
          })(),
          { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 5000, jitter: 0 },
          ctrl.signal,
        ),
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });
});
