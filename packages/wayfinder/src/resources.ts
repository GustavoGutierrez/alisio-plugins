import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ResourceRole } from "./types.js";

export const resourcePaths = {
  agents: "../.agents/agents",
  skills: "../.agents/skills",
} as const;

export const roleSkills: Record<ResourceRole, string> = {
  coordinator: "wayfinder-coordinate",
  discoverer: "wayfinder-discover",
  proposer: "wayfinder-propose",
  specifier: "wayfinder-specify",
  designer: "wayfinder-design",
  planner: "wayfinder-plan",
  implementer: "wayfinder-implement",
  verifier: "wayfinder-verify",
  archivist: "wayfinder-archive",
};

interface ParsedResource {
  frontmatter: Record<string, unknown>;
  body: string;
}

function scalar(source: string): string | boolean | number | string[] {
  const value = source.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")) : [];
  }
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseResource(source: string, label: string): ParsedResource {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match) throw new Error(`Malformed resource frontmatter: ${label}`);
  const frontmatter: Record<string, unknown> = {};
  let parent: Record<string, unknown> | undefined;
  for (const [index, line] of (match[1] ?? "").split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/\t|[&*!>|]/.test(line)) throw new Error(`Unsupported frontmatter syntax in ${label}`);
    const nested = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (nested && parent) {
      parent[nested[1] as string] = scalar(nested[2] as string);
      continue;
    }
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`Malformed frontmatter line ${index + 1} in ${label}`);
    const key = entry[1] as string;
    const raw = entry[2] as string;
    if (!raw) {
      parent = {};
      frontmatter[key] = parent;
    } else {
      frontmatter[key] = scalar(raw);
      parent = undefined;
    }
  }
  const body = (match[2] ?? "").trim();
  if (!body) throw new Error(`Resource body is empty: ${label}`);
  return { frontmatter, body };
}

async function load(path: string): Promise<ParsedResource> {
  const url = new URL(path, import.meta.url);
  return parseResource(await readFile(fileURLToPath(url), "utf8"), path);
}

function validateAgent(resource: ParsedResource, role: ResourceRole, skillName: string): void {
  const front = resource.frontmatter;
  const permission = front.permission;
  if (
    front.name !== role ||
    typeof front.description !== "string" ||
    !front.description ||
    !Array.isArray(front.tools) ||
    !Array.isArray(front.disallowedTools) ||
    !front.disallowedTools.includes("task") ||
    (role === "coordinator" ? front.mode !== "primary" : front.mode !== "subagent") ||
    typeof front.maxTurns !== "number" ||
    typeof front.readOnly !== "boolean" ||
    !permission ||
    typeof permission !== "object" ||
    Array.isArray(permission) ||
    !Array.isArray(front.skills) ||
    !front.skills.includes(skillName)
  ) {
    throw new Error(`Invalid agent resource: ${role}`);
  }
}

function validateSkill(resource: ParsedResource, skillName: string): void {
  const front = resource.frontmatter;
  const metadata = front.metadata;
  const headings = [
    "## Activation Contract",
    "## Hard Rules",
    "## Decision Gates",
    "## Execution Steps",
    "## Output Contract",
    "## References",
  ];
  let cursor = -1;
  for (const heading of headings) {
    const next = resource.body.indexOf(heading);
    if (next <= cursor) throw new Error(`Invalid skill section order: ${skillName}`);
    cursor = next;
  }
  if (
    front.name !== skillName ||
    typeof front.description !== "string" ||
    !front.description.startsWith("Trigger:") ||
    front.description.length > 250 ||
    front.license !== "MIT" ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("author" in metadata) ||
    !("version" in metadata) ||
    typeof metadata.author !== "string" ||
    typeof metadata.version !== "string"
  ) {
    throw new Error(`Invalid skill resource: ${skillName}`);
  }
}

export async function loadRoleInstructions(role: ResourceRole): Promise<string> {
  const skillName = roleSkills[role];
  const [agent, skill] = await Promise.all([
    load(`../.agents/agents/${role}.md`),
    load(`../.agents/skills/${skillName}/SKILL.md`),
  ]);
  validateAgent(agent, role, skillName);
  validateSkill(skill, skillName);
  return `${agent.body}\n\n# Loaded skill: ${skillName}\n\n${skill.body}`;
}
