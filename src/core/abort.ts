/** AbortSignal helpers. */

import { AbortError } from "./errors.js";

/**
 * Combine multiple AbortSignals. The result fires when any input fires.
 * Backed by AbortSignal.any (Bun 1.1+), which uses weak listeners internally —
 * so a long-lived caller signal reused across many runs accrues no lingering
 * listeners once each combined signal is unreferenced.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

/** Throw AbortError if the signal has fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError("aborted", { cause: signal.reason });
  }
}
