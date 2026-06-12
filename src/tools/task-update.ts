import type { Tool, ToolContext, ToolResult } from "./base.js";
import type { Task, TaskPatch } from "../sessions/tasks.js";
import { ToolExecutionError } from "../core/errors.js";

interface TaskUpdateInput {
  task_id: string;
  subject?: string;
  description?: string;
  active_form?: string;
  status?: string;
  owner?: string;
  add_blocks?: string[];
  add_blocked_by?: string[];
  remove_blocks?: string[];
  remove_blocked_by?: string[];
  metadata?: Record<string, unknown>;
}

const DIFF_FIELDS = ["subject", "status", "owner", "active_form", "description", "blocks", "blocked_by"] as const;

const VALID_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;

function diffTasks(before: Task, after: Task): string[] {
  const parts: string[] = [];
  for (const field of DIFF_FIELDS) {
    if (field === "blocks" || field === "blocked_by") {
      const bVal = before[field].slice().sort().join(",");
      const aVal = after[field].slice().sort().join(",");
      if (bVal !== aVal) {
        const bFmt = before[field].length ? before[field].map(id => `#${id}`).join(", ") : "(none)";
        const aFmt = after[field].length ? after[field].map(id => `#${id}`).join(", ") : "(none)";
        parts.push(`${field} ${bFmt} → ${aFmt}`);
      }
    } else {
      const bVal = before[field] ?? "";
      const aVal = after[field] ?? "";
      if (bVal !== aVal) {
        parts.push(`${field} ${bVal} → ${aVal}`);
      }
    }
  }
  return parts;
}

export class TaskUpdateTool implements Tool<TaskUpdateInput> {
  readonly name = "TaskUpdate";
  readonly description = "Update an existing task: change status, subject, owner, dependencies, or delete it.";
  readonly input_schema = {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "The task id to update." },
      subject: { type: "string" },
      description: { type: "string" },
      active_form: { type: "string" },
      status: { type: "string", enum: [...VALID_STATUSES] },
      owner: { type: "string" },
      add_blocks: { type: "array", items: { type: "string" } },
      add_blocked_by: { type: "array", items: { type: "string" } },
      remove_blocks: { type: "array", items: { type: "string" } },
      remove_blocked_by: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
    required: ["task_id"],
  };
  readonly scope = "write" as const;
  readonly parallelSafe = true;

  validate(raw: Record<string, unknown>): TaskUpdateInput {
    const task_id = raw["task_id"];
    if (typeof task_id !== "string" || task_id.trim() === "") {
      throw new ToolExecutionError("task_id must be a non-empty string", { tool_name: this.name });
    }
    const result: TaskUpdateInput = { task_id: task_id.trim() };

    for (const field of ["subject", "description", "active_form", "status", "owner"] as const) {
      const val = raw[field];
      if (val !== undefined) {
        if (typeof val !== "string") {
          throw new ToolExecutionError(`${field} must be a string`, { tool_name: this.name });
        }
        if (field === "status" && !VALID_STATUSES.includes(val as (typeof VALID_STATUSES)[number])) {
          throw new ToolExecutionError(
            `status must be one of: ${VALID_STATUSES.join(", ")}`,
            { tool_name: this.name },
          );
        }
        result[field] = val;
      }
    }

    for (const field of ["add_blocks", "add_blocked_by", "remove_blocks", "remove_blocked_by"] as const) {
      const val = raw[field];
      if (val !== undefined) {
        if (!Array.isArray(val) || val.some(v => typeof v !== "string")) {
          throw new ToolExecutionError(`${field} must be an array of strings`, { tool_name: this.name });
        }
        result[field] = val as string[];
      }
    }

    const metadata = raw["metadata"];
    if (metadata !== undefined) {
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        throw new ToolExecutionError("metadata must be an object", { tool_name: this.name });
      }
      result.metadata = metadata as Record<string, unknown>;
    }

    return result;
  }

  async execute(input: TaskUpdateInput, ctx: ToolContext): Promise<ToolResult> {
    const summary = this.summarize(input);

    // Snapshot before
    let before: Task | undefined;
    try {
      before = await ctx.sessionStore.getTask(ctx.sessionId, input.task_id);
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : "Failed to read task.",
        summary,
        is_error: true,
      };
    }

    if (!before) {
      return { content: "Task not found.", summary, is_error: true };
    }

    const patch: TaskPatch = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.description !== undefined) patch.description = input.description;
    if (input.active_form !== undefined) patch.active_form = input.active_form;
    if (input.status !== undefined) patch.status = input.status as TaskPatch["status"];
    if (input.owner !== undefined) patch.owner = input.owner;
    if (input.add_blocks !== undefined) patch.add_blocks = input.add_blocks;
    if (input.add_blocked_by !== undefined) patch.add_blocked_by = input.add_blocked_by;
    if (input.remove_blocks !== undefined) patch.remove_blocks = input.remove_blocks;
    if (input.remove_blocked_by !== undefined) patch.remove_blocked_by = input.remove_blocked_by;
    if (input.metadata !== undefined) patch.metadata = input.metadata;

    // Handle deletion
    if (patch.status === "deleted") {
      try {
        await ctx.sessionStore.updateTask(ctx.sessionId, input.task_id, patch);
        return { content: `Task #${input.task_id} deleted.`, summary };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : "Failed to delete task.",
          summary,
          is_error: true,
        };
      }
    }

    let after: Task | undefined;
    try {
      after = await ctx.sessionStore.updateTask(ctx.sessionId, input.task_id, patch);
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : "Failed to update task.",
        summary,
        is_error: true,
      };
    }

    if (!after) {
      return { content: "Task not found.", summary, is_error: true };
    }

    const diffs = diffTasks(before, after);
    const diffStr = diffs.length > 0 ? diffs.join("; ") : "no changes";
    return {
      content: `Task #${input.task_id} updated: ${diffStr}`,
      summary,
    };
  }

  summarize(input: TaskUpdateInput): string {
    return `Update task #${input.task_id}`;
  }
}
