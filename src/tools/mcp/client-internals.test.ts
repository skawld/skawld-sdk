/**
 * Unit tests for the pure helpers behind connectMcpServers:
 *   - listAllTools follows pagination cursors (G2)
 *   - findQualifiedNameProblems detects collisions + over-length names (G3/G9)
 */
import { describe, test, expect } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import { listAllTools, findQualifiedNameProblems } from "./client.js";

function tool(name: string): McpToolDefinition {
  return { name, inputSchema: { type: "object" } } as McpToolDefinition;
}

describe("listAllTools pagination", () => {
  test("concatenates every page until nextCursor is absent", async () => {
    const pages = [
      { tools: [tool("a"), tool("b")], nextCursor: "c1" },
      { tools: [tool("c")], nextCursor: "c2" },
      { tools: [tool("d")] },
    ];
    const seen: (string | undefined)[] = [];
    const fake = {
      async listTools(params?: { cursor?: string }) {
        seen.push(params?.cursor);
        return pages.shift()!;
      },
    } as unknown as Client;

    const all = await listAllTools(fake);
    expect(all.map((t) => t.name)).toEqual(["a", "b", "c", "d"]);
    // first call has no cursor, then follows c1, c2
    expect(seen).toEqual([undefined, "c1", "c2"]);
  });
});

describe("findQualifiedNameProblems", () => {
  test("same-server normalization collision is reported by origin", () => {
    const problems = findQualifiedNameProblems([
      { name: "srv", mcpTools: [tool("foo.bar"), tool("foo_bar")] },
    ]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("collisions");
    expect(problems[0]).toContain("foo.bar");
    expect(problems[0]).toContain("foo_bar");
    expect(problems[0]).toContain("mcp__srv__foo_bar");
  });

  test("cross-server boundary ambiguity is reported", () => {
    // server "a" + tool "b__c"  and  server "a__b" + tool "c"  → both mcp__a__b__c
    const problems = findQualifiedNameProblems([
      { name: "a", mcpTools: [tool("b__c")] },
      { name: "a__b", mcpTools: [tool("c")] },
    ]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("mcp__a__b__c");
  });

  test("over-128-char qualified name is rejected", () => {
    const problems = findQualifiedNameProblems([
      { name: "srv", mcpTools: [tool("x".repeat(140))] },
    ]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("128");
  });

  test("no problems for distinct, short names", () => {
    expect(
      findQualifiedNameProblems([{ name: "srv", mcpTools: [tool("a"), tool("b")] }]),
    ).toEqual([]);
  });
});
