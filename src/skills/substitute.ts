/** Substitute named args + reserved vars into a skill body. Pure, single-pass. */

import type { Skill } from "./types.js";
import { splitShellArgs } from "./shell-split.js";

export interface SubstituteOptions {
  skill: Skill;
  /** Raw args string (may be empty). */
  args: string;
  sessionId: string;
}

// Single regex pass: each token is matched and replaced exactly once, so a
// replacement's output is never re-scanned. Reserved alternatives precede the
// generic `$name` so e.g. `$ARGUMENTS` is consumed whole, not as `$ARGUMENT`+`S`.
const SUBST_RE =
  /\$\{SKAWLD_SKILL_DIR\}|\$\{SKAWLD_SESSION_ID\}|\$ARGUMENTS|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function substituteSkillBody(opts: SubstituteOptions): string {
  const { skill, args, sessionId } = opts;
  const tokens = splitShellArgs(args);
  const names = skill.frontmatter.arguments ?? [];
  const slots = new Map<string, string>();
  for (let i = 0; i < names.length; i++) {
    slots.set(names[i]!, tokens[i] ?? "");
  }

  const body = skill.body.replace(SUBST_RE, (m, slot: string | undefined) => {
    if (m === "${SKAWLD_SKILL_DIR}") return skill.dir;
    if (m === "${SKAWLD_SESSION_ID}") return sessionId;
    if (m === "$ARGUMENTS") return args;
    // Declared slot → its value; any other $name passes through verbatim.
    const value = slot !== undefined ? slots.get(slot) : undefined;
    return value ?? m;
  });

  return `Skill base directory: ${skill.dir}\n\n${body}`;
}
