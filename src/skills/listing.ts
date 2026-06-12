/** Build the `skill_listing` text block. Byte-stable for the same input. */

import type { Skill } from "./types.js";

const MAX_PER_ENTRY = 250;
const MIN_DESC_LEN = 20;
const FALLBACK_BUDGET = 8000;
const BUDGET_FRACTION = 0.01;
const CHARS_PER_TOKEN = 4;

export interface BuildSkillListingOptions {
  skills: readonly Skill[];
  /** When omitted, falls back to FALLBACK_BUDGET chars. */
  contextWindowTokens?: number;
}

export function buildSkillListing(opts: BuildSkillListingOptions): string {
  const visible = opts.skills
    .filter(s => !s.frontmatter.disableModelInvocation)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  if (visible.length === 0) return "";

  const budget = opts.contextWindowTokens !== undefined
    ? Math.floor(opts.contextWindowTokens * CHARS_PER_TOKEN * BUDGET_FRACTION)
    : FALLBACK_BUDGET;

  const descriptions = visible.map(s => capDescription(buildEntryDescription(s), MAX_PER_ENTRY));
  const render = (name: string, desc: string) => `- ${name}: ${desc}`;

  const fullText = visible.map((s, i) => render(s.name, descriptions[i]!)).join("\n");
  if (fullText.length <= budget) return fullText;

  // Need to truncate. Fixed overhead per entry: "- name: " plus a newline between entries.
  const overheadPerEntry = visible.reduce((acc, s) => acc + `- ${s.name}: `.length, 0);
  const newlineOverhead = Math.max(visible.length - 1, 0);
  const maxDescLen = Math.floor((budget - overheadPerEntry - newlineOverhead) / visible.length);

  if (maxDescLen < MIN_DESC_LEN) return visible.map(s => `- ${s.name}`).join("\n");

  return visible.map((s, i) => render(s.name, capDescription(descriptions[i]!, maxDescLen))).join("\n");
}

function buildEntryDescription(s: Skill): string {
  let desc = s.frontmatter.description;
  if (s.frontmatter.whenToUse) desc += ` — ${s.frontmatter.whenToUse}`;
  if (s.frontmatter.argumentHint) desc += ` (args: ${s.frontmatter.argumentHint})`;
  // Collapse internal whitespace so a YAML block-scalar description (which keeps
  // newlines) can't inject extra lines into the one-line-per-skill listing.
  return desc.replace(/\s+/g, " ").trim();
}

function capDescription(desc: string, limit: number): string {
  if (desc.length <= limit) return desc;
  if (limit <= 1) return "…";
  return `${desc.slice(0, limit - 1)}…`;
}
