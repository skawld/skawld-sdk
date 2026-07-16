/**
 * Tolerant SSE transport for provider streams.
 *
 * Anthropic-compatible translation layers (GLM/Z.ai-style gateways, LiteLLM
 * shims, ...) occasionally emit malformed SSE frames — most often during
 * long-generation keepalives:
 *
 *   - a whole `event:` field line wrapped inside a data line
 *     (`data: event: ping` + `data: {}`), which SSE parsers join into
 *     `"event: ping\n{}"` and then fail to JSON.parse;
 *   - raw C0 control characters (tab, backspace, ...) leaked inside JSON
 *     string literals, which are illegal in JSON and kill the parse.
 *
 * The vendor SDKs' stream iterators throw on the first unparseable frame,
 * aborting the whole agent run for one bad keepalive. Claude Code's CLI, by
 * contrast, silently ignores frames it cannot understand — this module
 * restores that tolerance at the transport level, in front of any SDK parser:
 *
 *   1. REPAIR — unwrap mis-wrapped field lines, escape raw control chars
 *      inside JSON string literals.
 *   2. DROP — an event whose data still isn't valid JSON after repair is
 *      removed from the stream (reported via `onMalformedEvent`), never
 *      forwarded to the SDK parser.
 *
 * Spec-compliant streams pass through byte-identically.
 */

/** Notification hook for observability; must not throw. */
export type MalformedEventHandler = (rawEvent: string) => void;

/** Structural fetch signature — matches both vendor SDKs' custom-fetch slots. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TolerantSseOptions {
  fetch?: FetchLike;
  onMalformedEvent?: MalformedEventHandler;
}

// A data-line payload that is itself a bare SSE field line (e.g. "event: ping")
// — an upstream framing bug; a JSON payload can never start with "event:".
const WRAPPED_EVENT_FIELD_LINE = /^\s?(event:\s*[A-Za-z0-9_.-]+)\s*$/;

// Any C0 control char except \n and \r (those are SSE line structure and never
// appear inside a line's content).
// eslint-disable-next-line no-control-regex
const HAS_RAW_CONTROL_CHAR = /[\x00-\x09\x0B\x0C\x0E-\x1F]/;

/**
 * Escape raw C0 control characters found inside JSON string literals with
 * \u00XX escapes. Characters outside string literals are untouched (a tab
 * between tokens is legal JSON whitespace).
 */
export function escapeRawControlCharsInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/** True when a joined data payload is safe to hand to an SSE JSON parser. */
function isForwardableData(joined: string): boolean {
  const trimmed = joined.trim();
  if (trimmed === "" || trimmed === "[DONE]") return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stateful per-stream sanitizer. Feed decoded text chunks, receive sanitized
 * text; call flush() at end-of-stream for the tail. Buffers at most one SSE
 * event (until its blank-line terminator), so added latency is per-event only.
 */
export class TolerantSseEventFilter {
  private lineBuffer = "";
  /** Raw lines (with terminators) of the event currently being assembled. */
  private eventLines: string[] = [];
  /** Data payloads of the current event, post-repair. */
  private dataPayloads: string[] = [];

  constructor(private readonly onMalformedEvent: MalformedEventHandler = () => {}) {}

  processChunk(text: string): string {
    this.lineBuffer += text;
    let out = "";
    let idx: number;
    while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
      const rawLine = this.lineBuffer.slice(0, idx + 1);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      out += this.acceptLine(rawLine);
    }
    return out;
  }

  /** End-of-stream: release whatever is buffered (SDK parsers handle tails). */
  flush(): string {
    const tail = this.eventLines.join("") + this.lineBuffer;
    this.eventLines = [];
    this.dataPayloads = [];
    this.lineBuffer = "";
    return tail;
  }

  private acceptLine(rawLine: string): string {
    const line = rawLine.replace(/\r?\n$/, "");
    if (line === "") {
      // Blank line terminates the buffered event: validate and dispatch.
      return this.dispatchEvent(rawLine);
    }
    if (line.startsWith("data:")) {
      let payload = line.slice("data:".length);
      const wrapped = WRAPPED_EVENT_FIELD_LINE.exec(payload);
      if (wrapped) {
        // Restore the mis-wrapped field line to its intended framing.
        this.eventLines.push(wrapped[1] + terminatorOf(rawLine));
        return "";
      }
      if (HAS_RAW_CONTROL_CHAR.test(payload)) {
        payload = escapeRawControlCharsInJsonStrings(payload);
      }
      this.eventLines.push("data:" + payload + terminatorOf(rawLine));
      this.dataPayloads.push(payload.startsWith(" ") ? payload.slice(1) : payload);
      return "";
    }
    // Field lines (event:, id:, retry:) and comments buffer as-is.
    this.eventLines.push(rawLine);
    return "";
  }

  private dispatchEvent(blankLine: string): string {
    const lines = this.eventLines;
    const joinedData = this.dataPayloads.join("\n");
    this.eventLines = [];
    this.dataPayloads = [];
    if (lines.length === 0) return blankLine; // bare keepalive blank line
    if (isForwardableData(joinedData)) return lines.join("") + blankLine;
    this.reportMalformed(lines.join("") + blankLine);
    return "";
  }

  private reportMalformed(rawEvent: string): void {
    try {
      this.onMalformedEvent(rawEvent);
    } catch {
      /* observability must never break the stream */
    }
  }
}

function terminatorOf(rawLine: string): string {
  return rawLine.endsWith("\r\n") ? "\r\n" : rawLine.endsWith("\n") ? "\n" : "";
}

/** Pipe an SSE byte stream through the tolerant event filter. */
export function tolerantSseByteStream(
  body: ReadableStream<Uint8Array>,
  onMalformedEvent?: MalformedEventHandler,
): ReadableStream<Uint8Array> {
  const filter = new TolerantSseEventFilter(onMalformedEvent);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const out = filter.processChunk(decoder.decode(chunk, { stream: true }));
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const out = filter.processChunk(decoder.decode()) + filter.flush();
        if (out) controller.enqueue(encoder.encode(out));
      },
    }),
  );
}

/**
 * Wrap a fetch implementation so that text/event-stream responses are piped
 * through the tolerant filter before any SDK parser sees them. Non-SSE
 * responses pass through untouched.
 */
export function tolerantSseFetch(options: TolerantSseOptions = {}): FetchLike {
  const base = options.fetch ?? (globalThis.fetch as FetchLike);
  return async (input, init) => {
    const response = await base(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      return response;
    }
    return new Response(tolerantSseByteStream(response.body, options.onMalformedEvent), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
