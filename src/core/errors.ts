/** Typed error hierarchy. Always throw a subclass of SkawldError. */

export abstract class SkawldError extends Error {
  abstract readonly kind: string;
  readonly retryable: boolean = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class AuthError extends SkawldError {
  override readonly kind = "auth";
  override readonly retryable = false;
}

export class RateLimitError extends SkawldError {
  override readonly kind = "rate_limit";
  override readonly retryable = true;
  readonly retry_after_seconds?: number;
  constructor(message: string, options?: { retry_after_seconds?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.retry_after_seconds = options?.retry_after_seconds;
  }
}

export class ContextLengthError extends SkawldError {
  override readonly kind = "context_length";
  override readonly retryable = false;
}

export class PermissionDeniedError extends SkawldError {
  override readonly kind = "permission_denied";
  override readonly retryable = false;
  readonly tool_name: string;
  readonly reason: string;
  constructor(message: string, opts: { tool_name: string; reason: string; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.tool_name = opts.tool_name;
    this.reason = opts.reason;
  }
}

export class ToolExecutionError extends SkawldError {
  override readonly kind = "tool_execution";
  override readonly retryable = false;
  readonly tool_name: string;
  constructor(message: string, opts: { tool_name: string; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.tool_name = opts.tool_name;
  }
}

export class AbortError extends SkawldError {
  override readonly kind = "abort";
  override readonly retryable = false;
}

export class ProviderError extends SkawldError {
  override readonly kind = "provider";
  readonly status?: number;
  override readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export class ConfigError extends SkawldError {
  override readonly kind = "config";
  override readonly retryable = false;
}

export class SkillError extends SkawldError {
  override readonly kind = "skill";
  override readonly retryable = false;
  readonly skillName?: string;
  constructor(message: string, opts?: { skillName?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.skillName = opts?.skillName;
  }
}

/** A SessionStore contract violation (missing session, dangling task edge, …). */
export class SessionStoreError extends SkawldError {
  override readonly kind = "session_store";
  override readonly retryable = false;
}
