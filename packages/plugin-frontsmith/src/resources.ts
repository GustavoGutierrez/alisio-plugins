import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type AgentProfile, type FsRole, roleOf, roleSkills } from "./application/agents/roster.js";
import {
  agentProblems,
  type ParsedResource,
  parseResource,
  skillProblems,
} from "./domain/resources/frontmatter.js";

/** Directories registered with the host catalog (relative to the built entry `dist/`). */
export const resourcePaths = {
  agents: "../.agents/agents",
  skills: "../.agents/skills",
} as const;

const url = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

async function read(path: string): Promise<{ resource: ParsedResource; raw: string }> {
  const raw = await readFile(url(path), "utf8");
  return { resource: parseResource(raw, path), raw };
}

function requireRole(roleOrAgent: string): FsRole {
  const role = roleOf(roleOrAgent);
  if (role === undefined) throw new Error(`Unknown Frontsmith role resource: ${roleOrAgent}`);
  return role;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

/** Loads and validates one agent and its skills; the single source of child instructions (spec 5.2). */
async function loadResources(role: FsRole): Promise<{
  agent: ParsedResource;
  instructions: string;
}> {
  const name = `fs-${role}`;
  const skills = roleSkills[role];
  const [agent, ...loaded] = await Promise.all([
    read(`../.agents/agents/${name}.md`),
    ...skills.map((skill) => read(`../.agents/skills/${skill}/SKILL.md`)),
  ]);
  const problems = agentProblems(agent.resource, {
    name,
    mode: role === "coordinator" ? "primary" : "subagent",
    skills,
  });
  if (problems.length > 0)
    throw new Error(`Invalid agent resource ${name}: ${problems.join("; ")}`);
  loaded.forEach((skill, index) => {
    const skillName = skills[index] as string;
    const skillIssues = skillProblems(skill.resource, skillName, skill.raw);
    if (skillIssues.length > 0)
      throw new Error(`Invalid skill resource ${skillName}: ${skillIssues.join("; ")}`);
  });
  const instructions = [
    agent.resource.body,
    ...loaded.flatMap((skill, index) => [`# Loaded skill: ${skills[index]}`, skill.resource.body]),
  ].join("\n\n");
  return { agent: agent.resource, instructions };
}

/**
 * Agent body plus every loaded skill body (`# Loaded skill: <name>` separators). Accepts the bare
 * role (`architect`) and the agent name (`fs-architect`); anything else rejects, which is also what
 * `scripts/pack-check.mjs` relies on for its deep check.
 */
export async function loadRoleInstructions(roleOrAgent: string): Promise<string> {
  return (await loadResources(requireRole(roleOrAgent))).instructions;
}

/** Everything a runner needs to start a child session for one agent. */
export async function loadAgentProfile(roleOrAgent: string): Promise<AgentProfile> {
  const role = requireRole(roleOrAgent);
  const { agent, instructions } = await loadResources(role);
  const front = agent.frontmatter;
  const permission = front.permission as Record<string, "allow" | "deny">;
  return {
    name: `fs-${role}`,
    role,
    instructions,
    tools: stringList(front.tools),
    disallowedTools: stringList(front.disallowedTools),
    mode: front.mode === "primary" ? "primary" : "subagent",
    maxTurns: front.maxTurns as number,
    timeoutMs: front.timeoutMs as number,
    maxOutputTokens: front.maxOutputTokens as number,
    readOnly: front.readOnly === true,
    permission: {
      write: permission.write as "allow" | "deny",
      process: permission.process as "allow" | "deny",
    },
    tier: front.tier as AgentProfile["tier"],
  };
}
