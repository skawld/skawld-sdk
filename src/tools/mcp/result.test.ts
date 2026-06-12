import { describe, test, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapMcpResult } from "./result.js";

describe("mapMcpResult", () => {
  test("maps text content", () => {
    const res = { content: [{ type: "text", text: "hello" }] } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.is_error).toBe(false);
    expect(out.summary).toBe("hello");
  });

  test("maps image content to base64 block", () => {
    const res = {
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);
  });

  test("degrades audio to text placeholder", () => {
    const res = {
      content: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
    } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([{ type: "text", text: "[audio content omitted]" }]);
  });

  test("emits embedded text resource with its URI", () => {
    const res = {
      content: [{ type: "resource", resource: { uri: "file://x", text: "y" } }],
    } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([{ type: "text", text: "[resource file://x]\ny" }]);
  });

  test("omits binary blob resource but keeps the URI", () => {
    const res = {
      content: [{ type: "resource", resource: { uri: "file://b", blob: "AAAA" } }],
    } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([{ type: "text", text: "[resource content omitted: file://b]" }]);
  });

  test("emits resource_link URI", () => {
    const res = {
      content: [{ type: "resource_link", uri: "https://x/y", name: "y" }],
    } as unknown as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toEqual([{ type: "text", text: "[resource link: https://x/y]" }]);
  });

  test("sets is_error and prefixes summary", () => {
    const res = { content: [{ type: "text", text: "boom" }], isError: true } as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.is_error).toBe(true);
    expect(out.summary).toBe("error: boom");
  });

  test("handles empty content", () => {
    const res = { content: [] } as unknown as CallToolResult;
    const out = mapMcpResult(res);
    expect(out.content).toBe("(no content)");
    expect(out.is_error).toBe(false);
  });
});
