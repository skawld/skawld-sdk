/**
 * Shared HTTP error-field extractors used by the Anthropic and OpenAI error
 * mappers. Both SDKs expose `status`/`statusCode` and a `retry-after` header in
 * the same shape, so these readers are identical across providers.
 */

/**
 * Read a structured error code (e.g. OpenAI's `context_length_exceeded`).
 * Both the SDK error and its nested `error` body may carry `code`.
 */
export function readErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; error?: { code?: unknown } };
  if (typeof e.code === "string") return e.code;
  if (typeof e.error?.code === "string") return e.error.code;
  return undefined;
}

export function readStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

export function readRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { headers?: Record<string, string> | Headers };
  const h = e.headers;
  if (!h) return undefined;
  const raw =
    typeof (h as Headers).get === "function"
      ? (h as Headers).get("retry-after")
      : (h as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  // Retry-After may be an HTTP-date instead of a delta-seconds integer.
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const deltaSeconds = (dateMs - Date.now()) / 1000;
    return deltaSeconds > 0 ? deltaSeconds : 0;
  }
  return undefined;
}
