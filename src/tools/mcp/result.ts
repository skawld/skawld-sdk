/**
 * Map an MCP `CallToolResult` into a skawld `ToolResult`.
 *
 * skawld tool results carry only text and image content (see ToolResult in
 * ../base.ts), so audio / embedded-resource blocks degrade to a text
 * placeholder. Mirrors Claude Code's `transformResultContent` minus the
 * blob-to-file persistence, which is out of scope for v1.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "../base.js";

type SkawldContentBlock = Exclude<ToolResult["content"], string>[number];

function transformBlock(block: CallToolResult["content"][number]): SkawldContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      };
    case "audio":
      return { type: "text", text: "[audio content omitted]" };
    case "resource": {
      const r = block.resource;
      // Embedded text resources carry their content inline — surface it (with the
      // URI as a header) instead of discarding it. Binary blobs stay omitted.
      if ("text" in r && typeof r.text === "string") {
        return { type: "text", text: `[resource ${r.uri}]\n${r.text}` };
      }
      return { type: "text", text: `[resource content omitted: ${r.uri}]` };
    }
    default: {
      // resource_link (and any future block type): emit at least the URI.
      const uri = (block as { uri?: unknown }).uri;
      if (typeof uri === "string") return { type: "text", text: `[resource link: ${uri}]` };
      return { type: "text", text: "[unsupported content omitted]" };
    }
  }
}

/** Build a short human-readable summary from the first text block. */
function summarize(blocks: SkawldContentBlock[], isError: boolean): string {
  const firstText = blocks.find((b): b is { type: "text"; text: string } => b.type === "text");
  const prefix = isError ? "error: " : "";
  if (firstText) {
    const oneLine = firstText.text.replace(/\s+/g, " ").trim();
    return prefix + (oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine || "(empty)");
  }
  return prefix + `${blocks.length} content block(s)`;
}

export function mapMcpResult(result: CallToolResult): ToolResult {
  const isError = result.isError === true;
  const content = result.content.map(transformBlock);
  return {
    content: content.length > 0 ? content : "(no content)",
    summary: summarize(content, isError),
    is_error: isError,
  };
}
