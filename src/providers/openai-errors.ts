/**
 * Shared OpenAI error mapper. Used by both Chat Completions and Responses providers.
 */

import {
  AbortError,
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  SkawldError,
} from "../core/errors.js";
import { readErrorCode, readRetryAfter, readStatus } from "./http-error-fields.js";

export function mapOpenAIError(err: unknown): SkawldError {
  if (err instanceof SkawldError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AbortError(err.message, { cause: err });
  }
  const status = readStatus(err);
  const message = readMessage(err);
  if (status === 401 || status === 403) {
    return new AuthError(message, { cause: err });
  }
  if (status === 429) {
    return new RateLimitError(message, {
      retry_after_seconds: readRetryAfter(err),
      cause: err,
    });
  }
  if (status === 400) {
    // Prefer the structured code; only fall back to a narrow message regex when
    // no code is present. A broad regex (matching "max_tokens", "too long")
    // misclassifies parameter-name and other 400s as context overflow,
    // triggering a wasted forced compaction + retry.
    const code = readErrorCode(err);
    if (
      code === "context_length_exceeded" ||
      (code === undefined && /prompt is too long|maximum context length/i.test(message))
    ) {
      return new ContextLengthError(message, { cause: err });
    }
    return new ProviderError(message, {
      status,
      retryable: false,
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(message, { status, retryable: true, cause: err });
  }
  return new ProviderError(message, {
    status,
    retryable: status === undefined,
    cause: err,
  });
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (typeof e.error?.message === "string") return e.error.message;
  }
  return String(err);
}
