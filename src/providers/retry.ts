/**
 * Retry a single request attempt that may throw a retryable SkawldError.
 *
 * Honors RateLimitError.retry_after_seconds when present, otherwise exponential
 * backoff with jitter. Aborts immediately on signal.
 */

import { AbortError, ConfigError, RateLimitError, SkawldError } from "../core/errors.js";

export interface RetryOptions {
  /** Maximum total attempts (including the first). Default 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff. Default 1000. */
  baseDelayMs?: number;
  /** Maximum delay between attempts in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Jitter fraction applied to backoff (0..1). Default 0.2. */
  jitter?: number;
}

export interface StreamRetryOptions extends Omit<RetryOptions, "maxAttempts"> {
  /** Retries after the first attempt. Default 5. */
  maxRetries?: number;
  /**
   * Initial stream items may be synthetic (for example message_start). They are
   * buffered until this returns true; failures before that point are retried
   * without leaking duplicate items to consumers.
   */
  shouldCommit?: (item: unknown) => boolean;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

function resolveOptions(opts: RetryOptions): ResolvedRetryOptions {
  const maxAttempts = opts.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConfigError("maxAttempts must be a positive integer");
  }
  return {
    maxAttempts,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 30000,
    jitter: opts.jitter ?? 0.2,
  };
}

function isRetryable(err: unknown): boolean {
  return err instanceof SkawldError && err.retryable;
}

// Server-specified Retry-After is honored up to a higher cap than the backoff
// cap; clamping a long Retry-After down would just guarantee another 429 and
// burn an attempt. Beyond this cap, fail fast with the rate-limit error.
const RETRY_AFTER_MAX_MS = 120_000;

function computeDelay(
  err: unknown,
  attempt: number,
  opts: ResolvedRetryOptions,
): number {
  if (err instanceof RateLimitError && err.retry_after_seconds !== undefined) {
    const requested = err.retry_after_seconds * 1000;
    if (requested > RETRY_AFTER_MAX_MS) throw err;
    return Math.max(0, requested);
  }
  const exp = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, opts.maxDelayMs);
  const jitterMs = capped * opts.jitter * (Math.random() * 2 - 1);
  return Math.max(0, capped + jitterMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError("aborted before sleep"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AbortError("aborted during backoff"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn` up to `maxAttempts` times. Retries only when the thrown error
 * extends SkawldError with `retryable: true`. Honors AbortSignal.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  signal: AbortSignal,
): Promise<T> {
  const resolved = resolveOptions(opts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
    if (signal.aborted) throw new AbortError("aborted");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err instanceof AbortError) throw err;
      if (!isRetryable(err)) throw err;
      if (attempt === resolved.maxAttempts - 1) break;
      const delay = computeDelay(err, attempt, resolved);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

function resolveStreamOptions(opts: StreamRetryOptions): ResolvedRetryOptions {
  const maxRetries = opts.maxRetries ?? 5;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ConfigError("maxRetries must be a non-negative integer");
  }
  return resolveOptions({
    ...opts,
    maxAttempts: maxRetries + 1,
  });
}

/**
 * Retry an async stream only while no item has been yielded to the caller.
 * Retrying after output begins would duplicate stream events and confuse the
 * engine's assistant/tool-use assembly.
 */
export async function* withRetryableStream<T>(
  createStream: () => AsyncIterable<T>,
  opts: StreamRetryOptions,
  signal: AbortSignal,
): AsyncIterable<T> {
  const resolved = resolveStreamOptions(opts);
  const shouldCommit = opts.shouldCommit ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
    if (signal.aborted) throw new AbortError("aborted");
    let committed = false;
    const pending: T[] = [];
    try {
      for await (const item of createStream()) {
        if (!committed) {
          pending.push(item);
          if (!shouldCommit(item)) continue;
          committed = true;
          for (const p of pending) yield p;
          pending.length = 0;
          continue;
        }
        yield item;
      }
      for (const p of pending) yield p;
      return;
    } catch (err) {
      lastErr = err;
      if (err instanceof AbortError) throw err;
      if (committed) throw err;
      if (!isRetryable(err)) throw err;
      if (attempt === resolved.maxAttempts - 1) break;
      const delay = computeDelay(err, attempt, resolved);
      await sleep(delay, signal);
    }
  }

  throw lastErr;
}
