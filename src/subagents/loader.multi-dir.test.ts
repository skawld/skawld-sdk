/**
 * Multi-directory tests for loadAgentsFromDir. Fixtures are built in fresh tmp
 * directories per test, mirroring loader.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentsFromDir } from "./loader.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skawld-agents-multidir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create `<root>/<dir>/agents/<name>.md` with a minimal valid frontmatter. */
async function writeAgent(dir: string, name: string, description: string): Promise<string> {
  const agentsDir = path.join(root, dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    path.join(agentsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n${name} body from ${dir}.\n`,
  );
  return path.join(root, dir);
}

describe("loadAgentsFromDir — multi-directory", () => {
  it("single string keeps loading unchanged (back-compat)", async () => {
    const dir = await writeAgent("solo", "alpha", "Alpha agent.");
    const { agents, skipped } = await loadAgentsFromDir({ configDir: dir });
    expect(skipped).toEqual([]);
    expect(agents.map((a) => a.name)).toEqual(["alpha"]);
  });

  it("loads the union of disjoint agents from all directories, sorted", async () => {
    const a = await writeAgent("law", "zeta", "Zeta from law.");
    const b = await writeAgent("tech", "alpha", "Alpha from tech.");
    const { agents, skipped } = await loadAgentsFromDir({ configDir: [a, b] });
    expect(skipped).toEqual([]);
    expect(agents.map((x) => x.name)).toEqual(["alpha", "zeta"]);
  });

  it("first directory wins on name collision; later duplicate is skipped", async () => {
    const a = await writeAgent("law", "twin", "Twin from law.");
    const b = await writeAgent("tech", "twin", "Twin from tech.");
    const { agents, skipped } = await loadAgentsFromDir({ configDir: [a, b] });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.body).toContain("from law");
    expect(agents[0]!.filePath.startsWith(a)).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision");
    expect(skipped[0]!.filePath.startsWith(b)).toBe(true);
  });

  it("skips a missing directory silently and loads the rest", async () => {
    const a = await writeAgent("law", "alpha", "Alpha from law.");
    const b = await writeAgent("tech", "beta", "Beta from tech.");
    const missing = path.join(root, "does-not-exist");
    const { agents, skipped } = await loadAgentsFromDir({ configDir: [a, missing, b] });
    expect(skipped).toEqual([]);
    expect(agents.map((x) => x.name)).toEqual(["alpha", "beta"]);
  });

  it("empty array loads nothing", async () => {
    const { agents, skipped } = await loadAgentsFromDir({ configDir: [] });
    expect(agents).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
