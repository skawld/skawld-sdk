import { describe, expect, it } from "bun:test";
import {
  escapeRawControlCharsInJsonStrings,
  TolerantSseEventFilter,
  tolerantSseFetch,
} from "./sse-tolerance.js";

const TAB = "\t";

function filterAll(chunks: string[], onMalformed?: (raw: string) => void): string {
  const f = new TolerantSseEventFilter(onMalformed);
  let out = "";
  for (const c of chunks) out += f.processChunk(c);
  return out + f.flush();
}

describe("escapeRawControlCharsInJsonStrings", () => {
  it("escapes raw control chars inside string literals only", () => {
    expect(escapeRawControlCharsInJsonStrings(`{"a":"x${TAB}y"}`)).toBe(`{"a":"x\\u0009y"}`);
    // tab between tokens is legal JSON whitespace — untouched
    expect(escapeRawControlCharsInJsonStrings(`{"a":${TAB}1}`)).toBe(`{"a":${TAB}1}`);
  });

  it("respects backslash escapes", () => {
    expect(escapeRawControlCharsInJsonStrings(`{"a":"x\\"${TAB}"}`)).toBe(`{"a":"x\\"\\u0009"}`);
  });
});

describe("TolerantSseEventFilter", () => {
  it("passes spec-compliant streams through byte-identically", () => {
    const clean =
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `data: [DONE]\n\n`;
    expect(filterAll([clean])).toBe(clean);
  });

  it("unwraps an event field line mis-wrapped inside a data line", () => {
    expect(filterAll([`data: event: ping\ndata: {}\n\n`])).toBe(`event: ping\ndata: {}\n\n`);
  });

  it("repairs raw control chars inside JSON string literals", () => {
    const out = filterAll([`data: {"delta":{"text":"a${TAB}b"}}\n\n`]);
    expect(out).toBe(`data: {"delta":{"text":"a\\u0009b"}}\n\n`);
  });

  it("drops an event whose data is still invalid JSON after repair", () => {
    const dropped: string[] = [];
    const out = filterAll(
      [`data: {"ok":1}\n\n`, `data: this is not json\n\n`, `data: {"ok":2}\n\n`],
      (raw) => dropped.push(raw),
    );
    expect(out).toBe(`data: {"ok":1}\n\ndata: {"ok":2}\n\n`);
    expect(dropped).toEqual([`data: this is not json\n\n`]);
  });

  it("validates multi-line data payloads as a joined document", () => {
    const multi = `data: {"a":\ndata: 1}\n\n`;
    expect(filterAll([multi])).toBe(multi);
  });

  it("handles events split across arbitrary chunk boundaries", () => {
    const out = filterAll([`data: eve`, `nt: ping\nda`, `ta: {}\n`, `\n`]);
    expect(out).toBe(`event: ping\ndata: {}\n\n`);
  });

  it("passes comments, retry fields, and bare keepalive blank lines through", () => {
    const s = `: keepalive\n\nretry: 3000\n\n\n`;
    expect(filterAll([s])).toBe(s);
  });

  it("releases an unterminated tail on flush", () => {
    expect(filterAll([`data: {"a":1}`])).toBe(`data: {"a":1}`);
  });

  it("never lets a throwing malformed-event handler break the stream", () => {
    const out = filterAll([`data: garbage\n\ndata: {"ok":1}\n\n`], () => {
      throw new Error("observer bug");
    });
    expect(out).toBe(`data: {"ok":1}\n\n`);
  });
});

describe("tolerantSseFetch", () => {
  it("filters event-stream bodies and leaves other responses untouched", async () => {
    const sse = `data: event: ping\ndata: {}\n\ndata: {"ok":1}\n\n`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stream")) {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(`{"plain":true}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const wrapped = tolerantSseFetch({ fetch: fetchImpl });
    const streamed = await wrapped("http://x/stream", {});
    expect(await streamed.text()).toBe(`event: ping\ndata: {}\n\ndata: {"ok":1}\n\n`);
    const plain = await wrapped("http://x/json", {});
    expect(await plain.text()).toBe(`{"plain":true}`);
  });
});
