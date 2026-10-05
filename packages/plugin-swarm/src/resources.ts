import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Pack, parsePack } from "./domain/pack.js";
import { parseToolchain, type Toolchain } from "./toolchains/profile.js";

export const resourcePaths = {
  agents: "../.agents/agents",
  skills: "../.agents/skills",
} as const;

/**
 * Every agent carries the `swarm-` prefix so the host agents catalog never collides with another
 * plugin that ships a `specifier` or `coder` of its own (Wayfinder does).
 */
export const resourceRoles = [
  "swarm-lieutenant",
  "swarm-specifier",
  "swarm-coder",
  "swarm-cleaner",
  "swarm-refactorer",
  "swarm-architect",
  "swarm-hardener",
  "swarm-qa",
] as const;
export type ResourceRole = (typeof resourceRoles)[number];

export const isResourceRole = (value: string): value is ResourceRole =>
  (resourceRoles as readonly string[]).includes(value);

/**
 * The single place that maps a pack role id (`coder`, `qa`, ...) to its agent name. Pack role ids
 * are unchanged; only the agent files carry the prefix. Unknown (custom) role ids have no agent
 * here: a custom pack names its own agent in `role.agent`.
 */
export function agentForRole(roleId: string): ResourceRole | undefined {
  const agent = `swarm-${roleId}`;
  return isResourceRole(agent) ? agent : undefined;
}

const handoff = "swarm-handoff-protocol";
const constitution = "swarm-engineering-constitution";

/** Skills each agent loads. The same files are the registered resources and the child instructions. */
export const roleSkills: Record<ResourceRole, string[]> = {
  "swarm-lieutenant": ["swarm-lieutenant"],
  "swarm-specifier": [handoff, constitution, "swarm-gherkin-spec", "swarm-clarification"],
  "swarm-coder": [
    handoff,
    constitution,
    "swarm-tdd-slice",
    "swarm-clarification",
    "swarm-toolchain-profile",
  ],
  "swarm-cleaner": [handoff, constitution, "swarm-cleaner-metrics", "swarm-toolchain-profile"],
  "swarm-refactorer": [handoff, constitution, "swarm-cleaner-metrics"],
  "swarm-architect": [handoff, constitution, "swarm-architecture-rules"],
  "swarm-hardener": [handoff, constitution, "swarm-mutation-hardening", "swarm-toolchain-profile"],
  "swarm-qa": [handoff, constitution, "swarm-qa-acceptance"],
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

const url = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

async function load(path: string): Promise<ParsedResource> {
  return parseResource(await readFile(url(path), "utf8"), path);
}

function validateAgent(resource: ParsedResource, role: ResourceRole, skillNames: string[]): void {
  const front = resource.frontmatter;
  const permission = front.permission;
  const declaredSkills = Array.isArray(front.skills) ? (front.skills as string[]) : undefined;
  if (
    front.name !== role ||
    typeof front.description !== "string" ||
    !front.description ||
    !Array.isArray(front.tools) ||
    !Array.isArray(front.disallowedTools) ||
    !front.disallowedTools.includes("task") ||
    (role === "swarm-lieutenant" ? front.mode !== "primary" : front.mode !== "subagent") ||
    typeof front.maxTurns !== "number" ||
    typeof front.readOnly !== "boolean" ||
    !permission ||
    typeof permission !== "object" ||
    Array.isArray(permission) ||
    !declaredSkills ||
    !skillNames.every((skillName) => declaredSkills.includes(skillName))
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

export interface AgentProfile {
  name: ResourceRole;
  /** Agent body plus every loaded skill body (the child session instructions). */
  instructions: string;
  tools: string[];
  disallowedTools: string[];
  mode: "primary" | "subagent";
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  readOnly: boolean;
  permission: { write: "allow" | "deny"; process: "allow" | "deny" };
}

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_OUTPUT_TOKENS = 16_000;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function level(value: unknown, label: string, role: string): "allow" | "deny" {
  // `ask` is never declared: a headless child would block on it (Phase 0 item, spec 16.1).
  if (value === "allow" || value === "deny") return value;
  throw new Error(`Invalid agent resource: ${role} (permission.${label})`);
}

/** Everything a runner needs to start a child session for one agent. */
export async function loadAgentProfile(role: ResourceRole): Promise<AgentProfile> {
  if (!isResourceRole(role)) throw new Error(`Unknown swarm role resource: ${String(role)}`);
  const agent = await load(`../.agents/agents/${role}.md`);
  const instructions = await loadRoleInstructions(role);
  const front = agent.frontmatter;
  const permission = front.permission as Record<string, unknown>;
  return {
    name: role,
    instructions,
    tools: stringList(front.tools),
    disallowedTools: stringList(front.disallowedTools),
    mode: front.mode === "primary" ? "primary" : "subagent",
    maxTurns: positive(front.maxTurns, 20),
    timeoutMs: positive(front.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputTokens: positive(front.maxOutputTokens, DEFAULT_OUTPUT_TOKENS),
    readOnly: front.readOnly === true,
    permission: {
      write: level(permission.write, "write", role),
      process: level(permission.process, "process", role),
    },
  };
}

/** Agent body plus every loaded skill body: the same files registered with the host. */
export async function loadRoleInstructions(role: ResourceRole): Promise<string> {
  if (!isResourceRole(role)) throw new Error(`Unknown swarm role resource: ${String(role)}`);
  const skillNames = roleSkills[role];
  const [agent, ...skills] = await Promise.all([
    load(`../.agents/agents/${role}.md`),
    ...skillNames.map((skillName) => load(`../.agents/skills/${skillName}/SKILL.md`)),
  ]);
  validateAgent(agent, role, skillNames);
  for (const [index, skill] of skills.entries()) {
    validateSkill(skill, skillNames[index] as string);
  }
  return [
    agent.body,
    ...skills.flatMap((skill, index) => [`# Loaded skill: ${skillNames[index]}`, skill.body]),
  ].join("\n\n");
}

const packNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

export async function listShippedPacks(): Promise<string[]> {
  const entries = await readdir(url("../assets/packs"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadShippedPack(name: string): Promise<Pack> {
  if (!packNamePattern.test(name)) throw new Error("Invalid pack name");
  if (!(await listShippedPacks()).includes(name)) throw new Error(`Unknown shipped pack: ${name}`);
  const pack = parsePack(
    JSON.parse(await readFile(url(`../assets/packs/${name}/pack.json`), "utf8")),
  );
  if (pack.name !== name) throw new Error(`Shipped pack ${name} declares a different name`);
  return pack;
}

export async function loadToolchain(id: string): Promise<Toolchain> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("Invalid toolchain id");
  let raw: string;
  try {
    raw = await readFile(url(`../assets/toolchains/${id}.json`), "utf8");
  } catch {
    throw new Error(`Unknown toolchain: ${id}`);
  }
  const profile = parseToolchain(JSON.parse(raw));
  if (profile.id !== id) throw new Error(`Toolchain ${id} declares a different id`);
  return profile;
}

export const dashboardAssets = ["dashboard.html", "dashboard.css", "dashboard.js"] as const;
export type DashboardAsset = (typeof dashboardAssets)[number];

/** A static dashboard file shipped in `assets/`, read relative to the built entry. */
export async function loadDashboardAsset(name: DashboardAsset): Promise<string> {
  if (!(dashboardAssets as readonly string[]).includes(name)) {
    throw new Error(`Unknown dashboard asset: ${name}`);
  }
  return readFile(url(`../assets/${name}`), "utf8");
}
