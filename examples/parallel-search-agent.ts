/**
 * Search the web with a remote MCP server. Run from the repository root:
 *   ANTHROPIC_API_KEY=... bun run examples/parallel-search-agent.ts "Your question"
 * Parallel needs no key for light use; model-provider usage is billed separately.
 */
import { Agent, type McpServerConfig } from "../src/sdk.js";
import { AnthropicProvider } from "../src/providers/index.js";
import type { BaseProvider } from "../src/providers/base.js";
import { ToolRegistry } from "../src/tools/index.js";
import { InMemorySessionStore } from "../src/sessions/index.js";

export const parallelSearchServers: Record<string, McpServerConfig> = {
  parallel: {
    type: "http",
    url: "https://search.parallel.ai/mcp",
    headers: { "User-Agent": "skawld-sdk/parallel-search-example" },
  },
};

/** Run the example with a chosen model provider and stream its answer to stdout. */
export async function searchWithParallel(provider: BaseProvider, model: string, prompt: string) {
  const agent = new Agent({
    provider,
    model,
    mcpServers: parallelSearchServers,
    // Start without local filesystem or shell tools.
    tools: new ToolRegistry(),
    sessionStore: new InMemorySessionStore(),
    permissions: {
      mode: "default",
      rules: [
        { kind: "tool", tool: "mcp__parallel__web_search", decision: "allow" },
        { kind: "tool", tool: "mcp__parallel__web_fetch", decision: "allow" },
        { kind: "tool", tool: "*", decision: "deny" },
      ],
    },
    systemPrompt: "Use Parallel web_search to research the question. Use web_fetch when you need more detail. Cite source URLs in your answer.",
  });

  try {
    const session = await agent.session();
    for await (const event of session.run(prompt)) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      }
      if (event.type === "tool_call_start") console.error(`[tool] ${event.tool_name}`);
      if (event.type === "tool_call_end" && event.is_error) {
        throw new Error(`Search tool failed: ${event.tool_name}`);
      }
      if (event.type === "error") throw new Error(event.error.message);
      if (event.type === "result") {
        if (event.subtype !== "success") throw new Error(`Agent run ${event.subtype}`);
        process.stdout.write("\n");
        break;
      }
    }
  } finally {
    await agent.close();
  }
}

if (import.meta.main) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY before running this example.");
    process.exit(1);
  }
  await searchWithParallel(
    new AnthropicProvider(),
    "claude-opus-4-5",
    process.argv.slice(2).join(" ") || "What is the Model Context Protocol? Find its official documentation and cite the source.",
  );
}
