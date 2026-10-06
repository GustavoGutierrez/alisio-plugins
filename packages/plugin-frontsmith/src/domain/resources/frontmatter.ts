/**
 * Agent and skill files are Markdown with a small YAML frontmatter. The parser accepts only what the
 * shipped files use (top-level scalars, flow lists, one level of nested mapping) so a malformed file
 * fails loudly instead of loading as something else (spec 5.2, 6).
 */
export interface ParsedResource {
  frontmatter: Record<string, unknown>;
  /** Top-level keys in file order; agent files are pinned to the order of spec 5.2. */
  keys: string[];
  body: string;
}

type Scalar = string | boolean | number | string[];

function scalar(source: string): Scalar {
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
  const keys: string[] = [];
  let parent: Record<string, unknown> | undefined;
  for (const [index, line] of (match[1] ?? "").split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (
      /\t|[&*!>|]/.test(line.replace(/^([A-Za-z][\w-]*:\s*)(["'][\s\S]*["']|\[[\s\S]*\])$/, "$1"))
    )
      throw new Error(`Unsupported frontmatter syntax in ${label}`);
    const nested = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (nested && parent) {
      parent[nested[1] as string] = scalar(nested[2] as string);
      continue;
    }
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`Malformed frontmatter line ${index + 1} in ${label}`);
    const key = entry[1] as string;
    const raw = entry[2] as string;
    keys.push(key);
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
  return { frontmatter, keys, body };
}

/** Frontmatter keys of every agent file, in order (spec 5.2). */
export const agentKeyOrder = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "mode",
  "maxTurns",
  "permission",
  "hidden",
  "timeoutMs",
  "maxOutputTokens",
  "readOnly",
  "skills",
  "tier",
] as const;

export const delegationTools = ["task", "delegate", "subagent", "sessions_create"] as const;
export const readTools = [
  "read_file",
  "list_files",
  "search_text",
  "git_status",
  "git_diff",
] as const;
export const writeTools = [...readTools, "write_file", "edit_file", "run_process"] as const;

export const skillHeadings = [
  "## Activation Contract",
  "## Hard Rules",
  "## Decision Gates",
  "## Execution Steps",
  "## Output Contract",
  "## References",
] as const;

export const MAX_SKILL_LINES = 250;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Problems with an agent file; empty when it is valid. */
export function agentProblems(
  resource: ParsedResource,
  expected: { name: string; mode: "primary" | "subagent"; skills: readonly string[] },
): string[] {
  const front = resource.frontmatter;
  const problems: string[] = [];
  if (!sameList(resource.keys, agentKeyOrder))
    problems.push(`frontmatter keys must be exactly, in order: ${agentKeyOrder.join(", ")}`);
  if (front.name !== expected.name) problems.push(`name must be ${expected.name}`);
  if (typeof front.description !== "string" || front.description.length === 0)
    problems.push("description is required");
  const tools = front.tools;
  const allowed: readonly string[] = writeTools;
  if (!isStringList(tools) || tools.length === 0 || !tools.every((t) => allowed.includes(t)))
    problems.push("tools must be a list of built-in tool names");
  const disallowed = front.disallowedTools;
  if (!isStringList(disallowed) || !delegationTools.every((name) => disallowed.includes(name)))
    problems.push(`disallowedTools must include ${delegationTools.join(", ")}`);
  if (front.mode !== expected.mode) problems.push(`mode must be ${expected.mode}`);
  for (const key of ["maxTurns", "timeoutMs", "maxOutputTokens"])
    if (typeof front[key] !== "number" || (front[key] as number) <= 0)
      problems.push(`${key} must be a positive number`);
  const permission = front.permission;
  if (typeof permission !== "object" || permission === null || Array.isArray(permission))
    problems.push("permission must be a mapping");
  else
    for (const key of ["write", "process"]) {
      const value = (permission as Record<string, unknown>)[key];
      // `ask` is never declared: a headless child would block on it (spec 5.2).
      if (value !== "allow" && value !== "deny")
        problems.push(`permission.${key} must be allow or deny`);
    }
  if (front.hidden !== false) problems.push("hidden must be false");
  if (typeof front.readOnly !== "boolean") problems.push("readOnly must be a boolean");
  const readOnly = front.readOnly === true;
  if (isStringList(tools)) {
    const writes = tools.some((t) => ["write_file", "edit_file", "run_process"].includes(t));
    if (readOnly && writes) problems.push("a read-only agent cannot list write tools");
  }
  if (readOnly && typeof permission === "object" && permission !== null) {
    const p = permission as Record<string, unknown>;
    if (p.write !== "deny" || p.process !== "deny")
      problems.push("a read-only agent must deny write and process");
  }
  if (!isStringList(front.skills) || !sameList(front.skills, expected.skills))
    problems.push(`skills must be ${expected.skills.join(", ")}`);
  if (front.tier !== "reasoning" && front.tier !== "standard" && front.tier !== "fast")
    problems.push("tier must be reasoning, standard or fast");
  return problems;
}

/** Problems with a skill file; empty when it is valid (spec 6). */
export function skillProblems(resource: ParsedResource, name: string, raw: string): string[] {
  const front = resource.frontmatter;
  const problems: string[] = [];
  let cursor = -1;
  for (const heading of skillHeadings) {
    const at = resource.body.indexOf(`\n${heading}\n`);
    const position = at === -1 && resource.body.startsWith(`${heading}\n`) ? 0 : at;
    if (position === -1 || position <= cursor)
      problems.push(`heading out of order or missing: ${heading}`);
    else cursor = position;
  }
  if (front.name !== name) problems.push(`name must be ${name}`);
  if (
    typeof front.description !== "string" ||
    !front.description.startsWith("Trigger:") ||
    front.description.length > 250
  )
    problems.push("description must start with Trigger: and have at most 250 characters");
  if (front.license !== "MIT") problems.push("license must be MIT");
  const metadata = front.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof (metadata as Record<string, unknown>).author !== "string" ||
    (metadata as Record<string, unknown>).version === undefined
  )
    problems.push("metadata needs author and version");
  if (raw.split("\n").length >= MAX_SKILL_LINES)
    problems.push(`must stay under ${MAX_SKILL_LINES} lines`);
  return problems;
}
