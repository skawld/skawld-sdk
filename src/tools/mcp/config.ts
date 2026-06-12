/**
 * MCP server configuration types.
 *
 * Shape mirrors the Claude Agent SDK's `McpServerConfig` so configs are
 * copy-paste compatible. v1 supports stdio (local child process) and
 * Streamable HTTP transports only.
 */

/** Launch a local MCP server as a child process and talk over stdio. */
export interface McpStdioServerConfig {
  /** Optional discriminator; stdio is assumed when absent (SDK convention). */
  type?: "stdio";
  /** Executable to spawn, e.g. "npx". */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables, merged over the inherited process env. */
  env?: Record<string, string>;
  /** Per-call timeout in ms. Omit to use the SDK default (60s). */
  timeoutMs?: number;
}

/** Connect to a remote MCP server over Streamable HTTP. */
export interface McpHttpServerConfig {
  type: "http";
  /** Server endpoint URL. */
  url: string;
  /** Static headers sent with every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Per-call timeout in ms. Omit to use the SDK default (60s). */
  timeoutMs?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Resolve a config to its concrete transport kind (stdio is the default). */
export function mcpServerType(config: McpServerConfig): "stdio" | "http" {
  return config.type === "http" ? "http" : "stdio";
}
