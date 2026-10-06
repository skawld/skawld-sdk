import { afterEach, expect, spyOn, test } from "bun:test";
import { Agent } from "../../src/sdk.js";
import { BaseProvider, type ProviderRequest, type ProviderStreamEvent } from "../../src/providers/base.js";
import { parallelSearchServers, searchWithParallel } from "../../examples/parallel-search-agent.js";

const usage = { input_tokens: 1, output_tokens: 1 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Scripted inference; the answer is built from tool results received by the loop. */
class ResearchProvider extends BaseProvider {
  readonly id = "research-fixture";
  results: string[] = [];
  turn = 0;
  contextWindow() { return 200_000; }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    expect(req.tools.map(t => t.name).sort()).toEqual([
      "Subagent", "mcp__parallel__web_fetch", "mcp__parallel__web_search",
    ]);
    expect(req.model).toBe("fixture-model");
    const result = req.messages.at(-1)?.content.find(b => b.type === "tool_result");
    if (result?.type === "tool_result") {
      expect(result.is_error).toBeFalsy();
      this.results.push(typeof result.content === "string" ? result.content : result.content.map(b => b.type === "text" ? b.text : "").join("\n"));
    }
    yield { type: "message_start", model: req.model };
    if (this.turn < 2) {
      const fetch = this.turn === 1;
      yield { type: "tool_use_start", id: `call-${this.turn}`, name: fetch ? "mcp__parallel__web_fetch" : "mcp__parallel__web_search" };
      yield { type: "tool_use_input_delta", id: `call-${this.turn}`, json_delta: JSON.stringify(fetch
        ? { urls: ["https://modelcontextprotocol.io/introduction"], objective: "What is MCP?" }
        : { objective: "Find official Model Context Protocol documentation", search_queries: ["Model Context Protocol official documentation"] }) };
      yield { type: "tool_use_end", id: `call-${this.turn}` };
      yield { type: "message_end", stop_reason: "tool_use", usage };
    } else {
      yield { type: "text_delta", text: this.results.at(-1)! };
      yield { type: "message_end", stop_reason: "end_turn", usage };
    }
    this.turn++;
  }
}

function fixture(error = false) {
  const observed: Array<{ method: string; params: any; headers: Headers }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    expect(String(input)).toBe("https://search.parallel.ai/mcp");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("User-Agent")).toBe("skawld-sdk/parallel-search-example");
    if (!init?.body) return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init.body));
    observed.push({ method: rpc.method, params: rpc.params, headers });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === "initialize"
      ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : rpc.method === "tools/list"
      ? { tools: ["web_search", "web_fetch"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }
      : { content: [{ type: "text", text: "MCP connects AI applications to external tools and data. Source: https://modelcontextprotocol.io/introduction" }], ...(error ? { isError: true } : {}) };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  }) as typeof fetch;
  return observed;
}

test("example executes discovered HTTP search/fetch tools and prints their result", async () => {
  const observed = fixture();
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  const close = spyOn(Agent.prototype, "close");
  try {
    const provider = new ResearchProvider();
    await searchWithParallel(provider, "fixture-model", "What is MCP?");
    expect(provider.results).toHaveLength(2);
    expect(output.mock.calls.flat().join("")).toContain("https://modelcontextprotocol.io/introduction");
    expect(observed.filter(r => r.method === "tools/call").map(r => r.params.name)).toEqual(["web_search", "web_fetch"]);
    expect(observed.some(r => r.method === "tools/list")).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(parallelSearchServers.parallel).toEqual({ type: "http", url: "https://search.parallel.ai/mcp", headers: { "User-Agent": "skawld-sdk/parallel-search-example" } });
  } finally { output.mockRestore(); close.mockRestore(); }
});

test("example reports tool failure and closes the agent", async () => {
  fixture(true);
  const close = spyOn(Agent.prototype, "close");
  try {
    await expect(searchWithParallel(new ResearchProvider(), "fixture-model", "What is MCP?")).rejects.toThrow("Search tool failed");
    expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); }
});

test("example closes the agent when discovery fails", async () => {
  globalThis.fetch = (async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
  const close = spyOn(Agent.prototype, "close");
  try {
    await expect(searchWithParallel(new ResearchProvider(), "fixture-model", "What is MCP?")).rejects.toThrow("Failed to connect MCP server");
    expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); }
});


test("the example denies the automatically registered Subagent tool", async () => {
  const observed = fixture();
  const provider = new class extends BaseProvider {
    readonly id = "denied-tool-fixture";
    contextWindow() { return 200_000; }
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: "message_start", model: "fixture-model" };
      yield { type: "tool_use_start", id: "denied", name: "Subagent" };
      yield { type: "tool_use_input_delta", id: "denied", json_delta: JSON.stringify({ description: "Research", prompt: "What is MCP?" }) };
      yield { type: "tool_use_end", id: "denied" };
      yield { type: "message_end", stop_reason: "tool_use", usage };
    }
  }();
  await expect(searchWithParallel(provider, "fixture-model", "What is MCP?")).rejects.toThrow("Search tool failed: Subagent");
  expect(observed.filter(r => r.method === "tools/call")).toHaveLength(0);
});
