# Skawld SDK — Built-in Tool Catalog

📖 Docs: https://skawld.com/docs/tools

`defaultTools()` returns a `ToolRegistry` with these ten tools (registered in this order). The model calls them by `name`; the schemas below are what it sees. Add your own with `registry.register(tool)` — see `building-agents.md` → Custom tools.

## File & shell tools

### Read — scope `read`, parallel-safe
Read a file (text, images, notebooks). Read-before-Edit is tracked here.
| param | type | notes |
|---|---|---|
| `file_path` | string (required) | Absolute or relative to `cwd`. |
| `offset` | number | 1-indexed start line. Default 1. |
| `limit` | number | Max lines. Default 2000. |

### Write — scope `write`, NOT parallel-safe
Create or overwrite a file with full contents.
| param | type | notes |
|---|---|---|
| `file_path` | string (required) | Path to write. |
| `content` | string (required) | Full file contents. |

### Edit — scope `write`, NOT parallel-safe
Exact-string replacement. **Enforces Read-before-Edit**: the model must `Read` the file in this session first, or the edit fails.
| param | type | notes |
|---|---|---|
| `file_path` | string (required) | |
| `old_string` | string (required) | Exact text to find; must be unique unless `replace_all`. No `cat -n` line-number prefix. |
| `new_string` | string (required) | Replacement. |
| `replace_all` | boolean | Replace every occurrence. Default false. |

### Bash — scope `exec`, NOT parallel-safe
Run a shell command in `cwd`. The only `exec`-scope built-in; in `"default"`/`"acceptEdits"` mode it asks for permission unless a `bash` rule allows it. Streams progress via `ctx.emit`.
| param | type | notes |
|---|---|---|
| `command` | string (required) | Shell command. |
| `timeout_ms` | number | Default 120000, max 1800000. |
| `description` | string | Brief description of the command. |

### Glob — scope `read`, parallel-safe
Find files by glob pattern.
| param | type | notes |
|---|---|---|
| `pattern` | string (required) | e.g. `src/**/*.ts`. |
| `path` | string | Directory to search. Default `cwd`. |

### Grep — scope `read`, parallel-safe
Ripgrep-backed content search (falls back to a built-in matcher when `rg` is absent).
| param | type | notes |
|---|---|---|
| `pattern` | string (required) | Regex. |
| `path` | string | Root dir. Default `cwd`. |
| `glob` | string | File filter, e.g. `**/*.ts`. |
| `type` | string | rg type alias (`ts`, `js`, `py`, …). |
| `output_mode` | `"files_with_matches"` \| `"content"` \| `"count"` | Default `files_with_matches`. |
| `-i` | boolean | Case-insensitive. |
| `-n` | boolean | Line numbers (content mode). |
| `-A` / `-B` / `-C` | number | Context lines after / before / around. |
| `multiline` | boolean | `.` matches newlines. |
| `head_limit` | number | Max output lines. Default 250. |

## Task tools (persistent planning state)

Four tools manage a per-session task list the model uses to plan multi-step work. They are **always permitted** (no permission prompt, any mode) and persist in the session store, so a resumed session keeps its task list. Tasks form a dependency graph via `blocks` / `blocked_by`.

| Tool | Purpose |
|---|---|
| `TaskCreate` | Add a task. Input: `subject`, `description`, optional `active_form`, `metadata`. Returns a stable monotonic id. |
| `TaskList` | List all tasks for the session, ascending by id. |
| `TaskGet` | Fetch one task by id. |
| `TaskUpdate` | Patch a task: `subject`, `description`, `active_form`, `status`, `owner`, dependency edges (`add_blocks`/`add_blocked_by`/`remove_blocks`/`remove_blocked_by`), `metadata`. Set `status: "deleted"` to remove. |

### Task shape

```ts
type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  active_form?: string;          // present-tense label, e.g. "Writing tests"
  status: TaskStatus;
  owner?: string;
  blocks: string[];              // ids this task blocks
  blocked_by: string[];          // ids blocking this task
  metadata?: Record<string, unknown>;
  created_at: string;            // ISO-8601
  updated_at: string;
}
```

Embedding apps can also read/write tasks directly through the `SessionStore` (`createTask`, `getTask`, `listTasks`, `updateTask`, `deleteTask`) — useful for rendering a live task panel alongside the agent. See `building-agents.md` → Sessions.

## Conditionally-registered tools

These are **not** part of `defaultTools()` — the engine registers them only when the corresponding capability is configured:

| Tool | Registered when | Purpose |
|---|---|---|
| `AskUser` | `AgentOptions.askUser` handler is provided | Pause mid-run to ask the user 1–4 clarifying questions (single/multi-select + free text). See `building-agents.md` → AskUser. |
| `Skill` | one or more skills are loaded from `<configDir>/skills` | Lets the model invoke a skill. See `building-agents.md` → Skills. |
| `Subagent` | always on first `session()` (a built-in default agent exists) | Spawn a child session. See `building-agents.md` → Subagents. |

## Removing or restricting tools

- Start from `new ToolRegistry()` (from `@skawld/agent-sdk/tools`) and register only what you want, instead of `defaultTools()`.
- Or keep `defaultTools()` and **deny** tools via permission rules: `{ kind: "tool", tool: "Bash", decision: "deny" }`.
- Subagents get a filtered view of the parent's tools via their `tools:` frontmatter allowlist.
