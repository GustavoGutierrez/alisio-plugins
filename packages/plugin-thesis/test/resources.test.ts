import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadRoleInstructions,
  parseResource,
  resourcePaths,
  roleSkills,
} from "../src/resources.js";
import { roles } from "../src/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("resources", () => {
  it("ships exactly the 8 agents and 15 skills of the spec", async () => {
    const agents = (await readdir(`${root}.agents/agents`)).sort();
    expect(agents).toEqual(roles.map((role) => `${role}.md`).sort());
    const skills = (await readdir(`${root}.agents/skills`)).sort();
    expect(skills).toEqual(
      [
        "thesis-intake",
        "thesis-policy",
        "thesis-methodology",
        "thesis-outline",
        "thesis-search",
        "thesis-evidence",
        "thesis-writing",
        "thesis-citations",
        "thesis-figures",
        "thesis-math",
        "thesis-editing",
        "thesis-review",
        "thesis-build",
        "thesis-csl-authoring",
        "thesis-institution-norms",
      ].sort(),
    );
    expect(resourcePaths).toEqual({ agents: "../.agents/agents", skills: "../.agents/skills" });
  });

  it("loads instructions for every role with their skills", async () => {
    for (const role of roles) {
      const text = await loadRoleInstructions(role);
      expect(text.length, role).toBeGreaterThan(800);
      for (const skill of roleSkills[role]) expect(text).toContain(`# Loaded skill: ${skill}`);
    }
    await expect(loadRoleInstructions("thesis-unknown" as never)).rejects.toThrow(
      /Unknown thesis role/,
    );
  });

  it("gives every skill a Trigger description of at most 250 characters and complete sections", async () => {
    for (const name of await readdir(`${root}.agents/skills`)) {
      const parsed = parseResource(
        await readFile(`${root}.agents/skills/${name}/SKILL.md`, "utf8"),
        name,
      );
      const description = parsed.frontmatter.description as string;
      expect(description.startsWith("Trigger:"), name).toBe(true);
      expect(description.length, name).toBeLessThanOrEqual(250);
      expect(parsed.body.split("\n").length, name).toBeGreaterThan(30);
    }
  });

  it("keeps agents read-only, subagents bounded, and the coordinator primary", async () => {
    for (const role of roles) {
      const parsed = parseResource(
        await readFile(`${root}.agents/agents/${role}.md`, "utf8"),
        role,
      );
      const front = parsed.frontmatter;
      expect(front.mode).toBe(role === "thesis-coordinator" ? "primary" : "subagent");
      // The coordinator alone may run thesis_answer (a write-effect tool), gated by `ask`.
      const coordinator = role === "thesis-coordinator";
      expect(front.readOnly).toBe(!coordinator);
      expect(front.permission).toEqual({ write: coordinator ? "ask" : "deny", process: "deny" });
      for (const denied of ["task", "delegate", "subagent", "sessions_create"]) {
        expect(front.disallowedTools).toContain(denied);
      }
      expect(front.maxTurns as number).toBeGreaterThanOrEqual(8);
      expect(front.maxTurns as number).toBeLessThanOrEqual(20);
    }
  });

  it("rejects malformed resources", () => {
    expect(() => parseResource("no frontmatter", "x")).toThrow(/Malformed/);
    expect(() => parseResource("---\nname: a\n---\n", "x")).toThrow();
    expect(() => parseResource("---\nname: a*b\n---\nbody", "x")).toThrow(/Unsupported/);
  });
});
