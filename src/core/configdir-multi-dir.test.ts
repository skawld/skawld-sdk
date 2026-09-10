/**
 * Agent-level integration test for multi-directory configDir. Verifies that the
 * Agent constructor normalizes `configDir: string | string[]` into a resolved
 * list and that skills + subagents are loaded and merged from every directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, getAgentInternals } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skawld-agent-multidir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string): Promise<string> {
  const skillDir = path.join(root, dir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\ndescription: ${name} skill from ${dir}.\n---\n\nBody.\n`,
  );
  return path.join(root, dir);
}

async function writeAgentDef(dir: string, name: string): Promise<string> {
  const agentsDir = path.join(root, dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, `${name}.md`),
    `---\ndescription: ${name} agent from ${dir}.\n---\nBody.\n`,
  );
  return path.join(root, dir);
}

function makeAgent(configDir: string | string[]): Agent {
  return new Agent({
    provider: new MockProvider(),
    model: "test-model",
    sessionStore: new InMemorySessionStore(),
    configDir,
  });
}

describe("Agent configDir — multi-directory", () => {
  it("loads skills and subagents merged from two directories", async () => {
    const law = await writeSkill("law", "contract");
    await writeAgentDef("law", "paralegal");
    const tech = await writeSkill("tech", "deploy");
    await writeAgentDef("tech", "sre");

    const agent = makeAgent([law, tech]);
    await agent.session(); // triggers lazy skill + subagent loading

    const ai = getAgentInternals(agent);
    expect([...ai.skills.keys()].sort()).toEqual(["contract", "deploy"]);
    expect(ai.tools.get("Skill")).toBeDefined();
    expect(ai.skillListingText).toContain("contract");
    expect(ai.skillListingText).toContain("deploy");

    const agentNames = ai.subagentRegistry.list().map((a) => a.name).sort();
    expect(agentNames).toEqual(["paralegal", "sre"]);
  });

  it("first directory wins when the same skill name exists in both", async () => {
    const first = await writeSkill("first", "twin");
    const second = await writeSkill("second", "twin");

    const agent = makeAgent([first, second]);
    await agent.session();

    const ai = getAgentInternals(agent);
    expect(ai.skills.size).toBe(1);
    expect(ai.skills.get("twin")!.dir.startsWith(first)).toBe(true);
  });

  it("empty array falls back to the .skawld default (no skills found)", async () => {
    const agent = makeAgent([]);
    await agent.session();
    const ai = getAgentInternals(agent);
    // No .skawld dir in the tmp cwd → nothing loads, and no crash.
    expect(ai.skills.size).toBe(0);
    expect(ai.tools.get("Skill")).toBeUndefined();
  });
});
