/** System prompt assembler — cache-optimized. See docs/06-system-prompt.html. */

import type { SystemBlock } from "../providers/base.js";
import type { PermissionMode } from "./types.js";

export interface SystemPromptInputs {
  /** User's appended custom instructions (Agent.opts.systemPrompt). */
  userInstructions?: string;
  /** Working directory. */
  cwd: string;
  /** OS info: derive at Agent construction from process.platform + os.release(). */
  os: { platform: string; release: string; arch: string };
  /** Shell, derived from process.env.SHELL or "unknown". */
  shell: string;
  /** Node version. */
  nodeVersion: string;
  /** skawld package version. */
  skawldVersion: string;
  /** Names of registered tools, in stable order. */
  toolNames: string[];
  /** Permission mode. */
  permissionMode: PermissionMode;
}

export const BLOCK_A_IDENTITY = `
You are skawld, an autonomous software engineering agent. You work inside a
codebase on the user's computer, using the file and shell tools provided to
read, modify, and run code. Your goal is to complete the user's coding task
correctly and minimally.

Behave like an experienced engineer: read before you write, run before you
claim, prefer small focused changes, surface uncertainty instead of guessing.
Do not narrate trivial operations. Do not produce status reports unless the
user asked. When in doubt, ask one focused question.
`.trim();

export const BLOCK_A_TOOL_PROTOCOL = `
Tool use protocol:

- Read a file before you Edit it. The Edit tool will refuse if you have not.
- Edits require an exact byte-for-byte match of the old_string in the current
  file contents, including indentation. The line-number prefix shown by Read
  is NOT part of the file content; do not include it in old_string.
- Prefer Edit over Write when modifying an existing file. Use Write only for
  new files or full rewrites.
- Glob is for finding files by name pattern; Grep is for searching file
  contents. They are read-only; they do not modify anything.
- Bash runs in the user's environment with full permissions. There is no
  sandbox. Avoid commands that change global state unless the user asked for
  them. Default timeout is 2 minutes; use timeout_ms for longer builds/tests up
  to 30 minutes.
- Issue multiple tool calls in a single turn when they are independent. Read,
  Glob, and Grep can run concurrently; the engine will parallelize them.
- Use TaskCreate, TaskList, TaskGet, and TaskUpdate to track multi-step work.
  Mark tasks in_progress before working on them and completed when finished.
  Use TaskList to refresh state before continuing long or resumed work.
`.trim();

function blockBEnvironment(inp: SystemPromptInputs): string {
  return `
Environment:

- skawld version: ${inp.skawldVersion}
- Node: ${inp.nodeVersion}
- OS: ${inp.os.platform} ${inp.os.release} (${inp.os.arch})
- Shell: ${inp.shell}
- Working directory: ${inp.cwd}
- Permission mode: ${inp.permissionMode}
- Tools available: ${inp.toolNames.join(", ")}
`.trim();
}

function blockBUserInstructions(text: string): string {
  return `
User-provided instructions:

${text.trim()}
`.trim();
}

export function buildSystemBlocks(inp: SystemPromptInputs): SystemBlock[] {
  return [
    { type: "text", text: BLOCK_A_IDENTITY, cacheable: true },
    { type: "text", text: BLOCK_A_TOOL_PROTOCOL, cacheable: true },
    { type: "text", text: blockBEnvironment(inp), cacheable: true },
    ...(inp.userInstructions
      ? [{ type: "text" as const, text: blockBUserInstructions(inp.userInstructions), cacheable: true }]
      : []),
  ];
}

export function buildEnvUserPrefix(): string {
  // Local date — a UTC date shows tomorrow to users west of UTC every evening.
  const d = new Date();
  const localDate =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `
<env>
Today's date: ${localDate}
</env>
`.trim();
}
