import { ConfigError } from "../core/errors.js";
import type { Tool, ToolSchema } from "./base.js";
import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { EditTool } from "./edit.js";
import { BashTool } from "./bash.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { TaskCreateTool } from "./task-create.js";
import { TaskListTool } from "./task-list.js";
import { TaskGetTool } from "./task-get.js";
import { TaskUpdateTool } from "./task-update.js";

export class ToolRegistry {
  // Tool<any>: registry stores heterogeneous tools; input types are checked at call sites.
  private map = new Map<string, Tool<any>>();
  // The registry is immutable after connect, so the schema array is rebuilt only
  // when a tool registers — not on every turn/retry. A byte-stable array also
  // helps prompt caching.
  private schemaCache: ToolSchema[] | undefined;

  register(tool: Tool<any>): void {
    if (this.map.has(tool.name)) {
      throw new ConfigError(`tool '${tool.name}' already registered`);
    }
    this.map.set(tool.name, tool);
    this.schemaCache = undefined;
  }

  get(name: string): Tool<any> | undefined {
    return this.map.get(name);
  }

  list(): Tool<any>[] {
    return Array.from(this.map.values());
  }

  schemas(): ToolSchema[] {
    if (this.schemaCache === undefined) {
      this.schemaCache = this.list().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    return this.schemaCache;
  }
}

/** Returns a registry preloaded with the ten built-in tools in canonical order. */
export function defaultTools(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new ReadTool());
  reg.register(new WriteTool());
  reg.register(new EditTool());
  reg.register(new BashTool());
  reg.register(new GlobTool());
  reg.register(new GrepTool());
  reg.register(new TaskCreateTool());
  reg.register(new TaskListTool());
  reg.register(new TaskGetTool());
  reg.register(new TaskUpdateTool());
  return reg;
}
