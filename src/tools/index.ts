// Tool interface types
export type { Tool, ToolSchema, ToolScope, ToolContext, ToolResult, JSONSchema } from "./base.js";

// File read tracker
export { FileReadTracker } from "./file-tracker.js";

// Registry
export { ToolRegistry, defaultTools } from "./registry.js";

// Tool classes
export { ReadTool } from "./read.js";
export { WriteTool } from "./write.js";
export { EditTool } from "./edit.js";
export { BashTool } from "./bash.js";
export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { TaskCreateTool } from "./task-create.js";
export { TaskListTool } from "./task-list.js";
export { TaskGetTool } from "./task-get.js";
export { TaskUpdateTool } from "./task-update.js";

// Task persistence types (re-exported for tool authors / consumers).
export type { Task, TaskStatus, CreateTaskInput, TaskPatch } from "../sessions/tasks.js";

// AskUser tool (registered conditionally via AgentOptions.askUser).
export { AskUserTool } from "./ask-user.js";
export type {
  AskUserHandler, AskUserRequest, AskUserResponse, AskUserAnswer,
  AskUserInput, AskUserQuestion, AskUserOption,
} from "./ask-user.js";

// MCP client support.
export { connectMcpServers, makeMcpTool, buildMcpToolName, normalizeNameForMcp } from "./mcp/index.js";
export type {
  McpConnection, McpCallTool, McpServerConfig, McpStdioServerConfig, McpHttpServerConfig,
} from "./mcp/index.js";
