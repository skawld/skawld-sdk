/**
 * Connect to MCP servers and expose their tools as skawld `Tool`s.
 *
 * `connectMcpServers` opens one client per configured server (stdio child
 * process or Streamable HTTP), lists each server's tools, and wraps them via
 * `makeMcpTool`. Connection is fail-fast: if any server fails, every
 * already-opened client is torn down and an aggregated error is thrown.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../base.js";
import { ConfigError } from "../../core/errors.js";
import { SKAWLD_VERSION } from "../../core/version.js";
import { type McpServerConfig, type McpStdioServerConfig, mcpServerType } from "./config.js";
import { buildMcpToolName, normalizeNameForMcp } from "./naming.js";
import { makeMcpTool } from "./tool.js";

/** Providers reject tool names longer than this; mirror the limit at connect time. */
const QUALIFIED_NAME_MAX = 128;

/** A live set of MCP connections and the tools they expose. */
export interface McpConnection {
  /** All wrapped tools across every connected server. */
  tools: Tool[];
  /** Disconnect every server and kill stdio child processes. Idempotent. */
  close(): Promise<void>;
}

/**
 * Environment for a stdio child process. The base is the MCP SDK's safe
 * subset (HOME, PATH, SHELL, …) so host secrets are not handed to every
 * server child; `inheritEnv: true` opts into the full host env. Explicit
 * `env` entries win over the base either way.
 */
export function stdioChildEnv(stdio: McpStdioServerConfig): Record<string, string> {
  const base = stdio.inheritEnv
    ? (process.env as Record<string, string>)
    : getDefaultEnvironment();
  return { ...base, ...(stdio.env ?? {}) };
}

function createTransport(config: McpServerConfig): Transport {
  if (mcpServerType(config) === "http") {
    const http = config as Extract<McpServerConfig, { type: "http" }>;
    return new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: http.headers ? { headers: http.headers } : undefined,
    });
  }
  const stdio = config as McpStdioServerConfig;
  return new StdioClientTransport({
    command: stdio.command,
    args: stdio.args ?? [],
    env: stdioChildEnv(stdio),
    // Inherit so the child's diagnostics reach our stderr and no unread pipe
    // can fill and block a chatty server.
    stderr: "inherit",
  });
}

/** Fetch every page of a server's tool list — cursor handling is the caller's job. */
export async function listAllTools(client: Client): Promise<McpToolDefinition[]> {
  const all: McpToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor !== undefined ? { cursor } : undefined);
    all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return all;
}

async function connectOne(
  name: string,
  config: McpServerConfig,
): Promise<{ name: string; client: Client; config: McpServerConfig; mcpTools: McpToolDefinition[] }> {
  const client = new Client({ name: "skawld", version: SKAWLD_VERSION }, { capabilities: {} });
  await client.connect(createTransport(config));
  try {
    const mcpTools = await listAllTools(client);
    return { name, client, config, mcpTools };
  } catch (err) {
    // The child process already spawned during connect(); close it so a
    // post-connect failure (e.g. listTools) does not leak it.
    await client.close().catch(() => {});
    throw err;
  }
}

function wrapTools(
  serverName: string,
  client: Client,
  config: McpServerConfig,
  mcpTools: McpToolDefinition[],
): Tool[] {
  const timeoutMs = config.timeoutMs;
  return mcpTools.map((t) =>
    makeMcpTool(serverName, t, (toolName, args, signal): Promise<CallToolResult> =>
      client.callTool(
        { name: toolName, arguments: args },
        undefined,
        timeoutMs !== undefined
          ? { signal, timeout: timeoutMs, resetTimeoutOnProgress: true }
          : { signal },
      ) as Promise<CallToolResult>,
    ),
  );
}

/**
 * Detect qualified-name collisions and over-length names across all servers.
 * Normalization (`foo.bar` and `foo_bar` → `foo_bar`) or cross-server boundary
 * ambiguity (`a__b` + `c` vs `a` + `b__c`) can make two tools share one name —
 * registering both would throw deep inside the memoized connect and brick every
 * future session. Surface it here, once, naming the offenders.
 */
export function findQualifiedNameProblems(
  opened: { name: string; mcpTools: McpToolDefinition[] }[],
): string[] {
  const seen = new Map<string, { server: string; tool: string }>();
  const collisions: string[] = [];
  const tooLong: string[] = [];
  for (const o of opened) {
    for (const t of o.mcpTools) {
      const qualified = buildMcpToolName(o.name, t.name);
      if (qualified.length > QUALIFIED_NAME_MAX) {
        tooLong.push(`'${o.name}'/'${t.name}' → ${qualified.length} chars`);
      }
      const prev = seen.get(qualified);
      if (prev) {
        collisions.push(
          `'${qualified}' from server '${prev.server}' tool '${prev.tool}' and server '${o.name}' tool '${t.name}'`,
        );
      } else {
        seen.set(qualified, { server: o.name, tool: t.name });
      }
    }
  }
  const problems: string[] = [];
  if (collisions.length > 0) problems.push(`qualified tool-name collisions: ${collisions.join("; ")}`);
  if (tooLong.length > 0) {
    problems.push(`qualified tool-name exceeds ${QUALIFIED_NAME_MAX} chars: ${tooLong.join("; ")}`);
  }
  return problems;
}

/** Connect to every configured MCP server. Fail-fast with full teardown. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpConnection> {
  const entries = Object.entries(servers);
  const normalized = new Set<string>();
  for (const [name] of entries) {
    if (name.trim() === "") throw new ConfigError("MCP server name must be non-empty");
    const key = normalizeNameForMcp(name);
    if (normalized.has(key)) {
      throw new ConfigError(`MCP server names collide after normalization: '${name}' → '${key}'`);
    }
    normalized.add(key);
  }

  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectOne(name, cfg)));

  const opened = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = entries.flatMap(([name], i) =>
    settled[i]!.status === "rejected"
      ? [`${name}: ${reason((settled[i] as PromiseRejectedResult).reason)}`]
      : [],
  );

  if (failures.length > 0) {
    await Promise.allSettled(opened.map((o) => o.client.close()));
    throw new ConfigError(`Failed to connect MCP server(s): ${failures.join("; ")}`);
  }

  const problems = findQualifiedNameProblems(opened);
  if (problems.length > 0) {
    await Promise.allSettled(opened.map((o) => o.client.close()));
    throw new ConfigError(`MCP tool registration failed: ${problems.join(". ")}`);
  }

  const clients = opened.map((o) => o.client);
  const tools = opened.flatMap((o) => wrapTools(o.name, o.client, o.config, o.mcpTools));
  let closed = false;
  return {
    tools,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
