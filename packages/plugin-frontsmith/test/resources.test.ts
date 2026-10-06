import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentName,
  agentNames,
  roleEnvelope,
  roleSkills,
  roles,
  skillNames,
} from "../src/application/agents/roster.js";
import { envelopeKinds } from "../src/domain/envelopes/parse.js";
import { shippedAgentTiers } from "../src/domain/models/agents.js";
import {
  agentKeyOrder,
  agentProblems,
  parseResource,
  readTools,
  skillHeadings,
  skillProblems,
  writeTools,
} from "../src/domain/resources/frontmatter.js";
import { loadAgentProfile, loadRoleInstructions } from "../src/resources.js";

const packageRoot = join(import.meta.dirname, "..");
const agentsDir = join(packageRoot, ".agents", "agents");
const skillsDir = join(packageRoot, ".agents", "skills");
const read = (path: string): string => readFileSync(path, "utf8");

/** The twelve agent cards of spec 5.3 as limits and profile (W-03: the test engineer file is the build profile). */
const cards: Record<
  string,
  { maxTurns: number; timeoutMs: number; write: boolean; mode: "primary" | "subagent" }
> = {
  coordinator: { maxTurns: 6, timeoutMs: 120_000, write: false, mode: "primary" },
  specifier: { maxTurns: 10, timeoutMs: 300_000, write: false, mode: "subagent" },
  "ui-contractor": { maxTurns: 12, timeoutMs: 420_000, write: false, mode: "subagent" },
  tokensmith: { maxTurns: 8, timeoutMs: 300_000, write: false, mode: "subagent" },
  architect: { maxTurns: 14, timeoutMs: 480_000, write: false, mode: "subagent" },
  "test-engineer": { maxTurns: 30, timeoutMs: 900_000, write: true, mode: "subagent" },
  implementer: { maxTurns: 40, timeoutMs: 900_000, write: true, mode: "subagent" },
  "data-engineer": { maxTurns: 40, timeoutMs: 900_000, write: true, mode: "subagent" },
  "a11y-auditor": { maxTurns: 10, timeoutMs: 300_000, write: false, mode: "subagent" },
  "fidelity-reviewer": { maxTurns: 8, timeoutMs: 300_000, write: false, mode: "subagent" },
  reviewer: { maxTurns: 12, timeoutMs: 480_000, write: false, mode: "subagent" },
  archivist: { maxTurns: 6, timeoutMs: 180_000, write: false, mode: "subagent" },
};

describe("agent files", () => {
  it("ships exactly the twelve agents of the roster", () => {
    expect(readdirSync(agentsDir).sort()).toEqual(agentNames.map((n) => `${n}.md`).sort());
    expect(roles).toHaveLength(12);
  });

  for (const role of roles) {
    const name = agentName(role);
    describe(name, () => {
      const source = read(join(agentsDir, `${name}.md`));
      const resource = parseResource(source, name);
      const card = cards[role] as (typeof cards)[string];

      it("has valid frontmatter in the order of spec 5.2", () => {
        expect(resource.keys).toEqual([...agentKeyOrder]);
        expect(
          agentProblems(resource, { name, mode: card.mode, skills: roleSkills[role] }),
        ).toEqual([]);
      });

      it("pins its tier to the shipped default tier (spec 16.2)", () => {
        expect(resource.frontmatter.tier).toBe(shippedAgentTiers[name]);
      });

      it("uses the profile and limits of its card", () => {
        const front = resource.frontmatter;
        expect(front.maxTurns).toBe(card.maxTurns);
        expect(front.timeoutMs).toBe(card.timeoutMs);
        expect(front.readOnly).toBe(!card.write);
        expect(front.permission).toEqual(
          card.write ? { write: "allow", process: "allow" } : { write: "deny", process: "deny" },
        );
        expect(front.tools).toEqual(card.write ? [...writeTools] : [...readTools]);
        expect(front.disallowedTools).toEqual(["task", "delegate", "subagent", "sessions_create"]);
        expect(front.hidden).toBe(false);
      });

      it("ends with the envelope sentence, or the plain-text one for the primary agent", () => {
        if (role === "coordinator")
          expect(
            resource.body.endsWith(
              "Your final message is plain text for the person you are helping, never a JSON envelope.",
            ),
          ).toBe(true);
        else
          expect(
            resource.body.endsWith(
              "Your final message is exactly one JSON object matching the envelope in your prompt. No prose before or after it.",
            ),
          ).toBe(true);
      });

      it("names no research document and carries no machine path", () => {
        expect(source).not.toMatch(
          /\b(?:METH|FID)\b|frontend-agent-engineering|fidelidad-ui|\/home\/|\/Users\//,
        );
      });
    });
  }

  it("declares its tier in the frontmatter of every file, matching shippedAgentTiers exactly", () => {
    const fromFiles = Object.fromEntries(
      agentNames.map((name) => [
        name,
        parseResource(read(join(agentsDir, `${name}.md`)), name).frontmatter.tier,
      ]),
    );
    expect(fromFiles).toEqual(shippedAgentTiers);
  });

  it("maps every role to envelopes that exist", () => {
    for (const role of roles)
      for (const kind of roleEnvelope[role]) expect(envelopeKinds).toContain(kind);
  });
});

describe("skill files", () => {
  it("ships exactly the sixteen skills of the spec table", () => {
    expect(readdirSync(skillsDir).sort()).toEqual([...skillNames].sort());
    expect(skillNames).toHaveLength(16);
  });

  it("names only skills that exist in roleSkills", () => {
    for (const role of roles)
      for (const skill of roleSkills[role]) expect(skillNames).toContain(skill);
    const used = new Set(roles.flatMap((role) => roleSkills[role]));
    for (const skill of skillNames)
      expect(used.has(skill), `${skill} is loaded by no agent`).toBe(true);
  });

  for (const name of skillNames) {
    describe(name, () => {
      const raw = read(join(skillsDir, name, "SKILL.md"));
      const resource = parseResource(raw, name);

      it("has the six headings in order, a Trigger description and fewer than 250 lines", () => {
        expect(skillProblems(resource, name, raw)).toEqual([]);
        const headings = resource.body.split("\n").filter((line) => line.startsWith("## "));
        expect(headings).toEqual([...skillHeadings]);
        expect((resource.frontmatter.description as string).length).toBeLessThanOrEqual(250);
        expect(raw.split("\n").length).toBeLessThan(250);
      });

      it("links only the package README and never a research document", () => {
        expect(raw).not.toMatch(/\b(?:METH|FID)\b|frontend-agent-engineering|fidelidad-ui/);
        expect(raw).not.toMatch(/\/home\/|\/Users\//);
        const links = [...raw.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
        for (const link of links) expect(link).toBe("../../../README.md");
      });
    });
  }

  it("reports a skill that breaks the contract", () => {
    const bad = parseResource(
      `---\nname: fs-x\ndescription: "Not a trigger"\nlicense: MIT\nmetadata:\n  author: a\n  version: 1.0\n---\n## Hard Rules\n\n## Activation Contract\n`,
      "x",
    );
    expect(skillProblems(bad, "fs-x", "")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Trigger:"),
        expect.stringContaining("order"),
      ]),
    );
  });
});

describe("loadRoleInstructions", () => {
  it("accepts the bare role and the agent name and returns the same text", async () => {
    const bare = await loadRoleInstructions("architect");
    expect(await loadRoleInstructions("fs-architect")).toBe(bare);
    expect(bare).toContain("# Loaded skill: fs-architecture");
    expect(bare).toContain("# Loaded skill: fs-task-contracts");
  });

  it("loads every role with its agent body first and every skill body after it", async () => {
    for (const role of roles) {
      const text = await loadRoleInstructions(role);
      const agent = parseResource(read(join(agentsDir, `${agentName(role)}.md`)), role);
      expect(text.startsWith(agent.body)).toBe(true);
      for (const skill of roleSkills[role]) expect(text).toContain(`# Loaded skill: ${skill}`);
    }
  });

  it.each([
    "",
    "bogus",
    "fs-bogus",
    "fs-",
    "../fs-architect",
    "FS-architect",
    "architect.md",
    "swarm-coder",
  ])("rejects %j", async (value) => {
    await expect(loadRoleInstructions(value)).rejects.toThrow();
  });
});

describe("loadAgentProfile", () => {
  it("returns the profile of the card, the tier and the full instructions", async () => {
    const profile = await loadAgentProfile("fs-implementer");
    expect(profile).toMatchObject({
      name: "fs-implementer",
      role: "implementer",
      mode: "subagent",
      readOnly: false,
      maxTurns: 40,
      tier: "standard",
      permission: { write: "allow", process: "allow" },
    });
    expect(profile.tools).toEqual([...writeTools]);
    expect(profile.instructions).toBe(await loadRoleInstructions("implementer"));
  });

  it("gives read-only roles the read profile and the coordinator the primary mode", async () => {
    expect(await loadAgentProfile("reviewer")).toMatchObject({
      readOnly: true,
      tier: "reasoning",
      permission: { write: "deny", process: "deny" },
    });
    expect(await loadAgentProfile("coordinator")).toMatchObject({ mode: "primary", tier: "fast" });
  });

  it("rejects an unknown role", async () => {
    await expect(loadAgentProfile("nobody")).rejects.toThrow();
  });
});
