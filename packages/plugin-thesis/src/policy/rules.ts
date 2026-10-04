import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { isKnownKind } from "./kinds.js";

export const ruleLevels = [
  "LAW",
  "REGULATION",
  "INSTITUTIONAL_RULE",
  "PROGRAM_RULE",
  "TECHNICAL_STANDARD",
  "STYLE_GUIDE",
  "METHODOLOGY_GUIDELINE",
  "RECOMMENDATION",
] as const;
export type RuleLevel = (typeof ruleLevels)[number];
export type RuleStatus = "active" | "superseded" | "draft" | "withdrawn";
const ruleStatuses: readonly string[] = ["active", "superseded", "draft", "withdrawn"];

export const packScopes = [
  "global",
  "international",
  "country",
  "region",
  "institution",
  "faculty",
  "program",
  "writing",
] as const;
export type PackScope = (typeof packScopes)[number];

export type RuleTier =
  | "pack"
  | "institution"
  | "faculty"
  | "program"
  | "rubric"
  | "template"
  | "writing-guide"
  | "other-override";

export interface RuleOrigin {
  tier: RuleTier;
  packId?: string;
  scope?: PackScope;
  location?: "shipped" | "workspace";
  /** Faculty or program slug taken from `faculties/<slug>/` or `programs/<slug>/` inside a pack. */
  faculty?: string;
  program?: string;
  /** Path relative to the packs root or to the thesis root; never absolute. */
  file: string;
}

export interface PolicyRule {
  ruleId: string;
  level: RuleLevel;
  status: RuleStatus;
  overrides?: boolean;
  authority?: Record<string, unknown>;
  document?: Record<string, unknown>;
  appliesWhen?: Record<string, unknown>;
  requirement: { kind: string; values?: Record<string, unknown> };
  source: { reference: string; url?: string; retrievedAt?: string };
  verification: { lastChecked: string; basis: "official_text" | "secondary_source" };
  supersedes: string[];
}

export interface LoadedRule extends PolicyRule {
  origin: RuleOrigin;
}

export interface PackProblem {
  code: "PCK-001" | "PCK-002" | "POL-003";
  severity: "error" | "warning";
  file: string;
  message: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rulePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export const maxFileBytes = 512 * 1024;

/** Strictly validate one rule. Unknown extra keys are tolerated so packs can carry notes. */
export function parseRule(
  raw: unknown,
  origin: RuleOrigin,
): { rule?: LoadedRule; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: ["Rule must be a mapping"] };
  const label = typeof raw.ruleId === "string" ? raw.ruleId : "(no ruleId)";
  const fail = (message: string) => errors.push(`${label}: ${message}`);

  if (typeof raw.ruleId !== "string" || !rulePattern.test(raw.ruleId))
    fail("ruleId is missing or malformed");
  if (!ruleLevels.includes(raw.level as RuleLevel))
    fail(`level must be one of ${ruleLevels.join(", ")}`);
  if (typeof raw.status !== "string" || !ruleStatuses.includes(raw.status)) {
    fail(`status must be one of ${ruleStatuses.join(", ")}`);
  }
  const requirement = raw.requirement;
  if (!isRecord(requirement) || typeof requirement.kind !== "string") {
    fail("requirement.kind is missing");
  } else if (!isKnownKind(requirement.kind)) {
    fail(
      `requirement.kind "${requirement.kind}" is not in the closed vocabulary (extensions must be named x-<name>)`,
    );
  } else if (requirement.values !== undefined && !isRecord(requirement.values)) {
    fail("requirement.values must be a mapping");
  }
  const source = raw.source;
  if (
    !isRecord(source) ||
    typeof source.reference !== "string" ||
    !source.reference.trim() ||
    source.reference.length > 800
  ) {
    fail("source.reference is required");
  } else if (source.url !== undefined && typeof source.url !== "string") {
    fail("source.url must be a string");
  }
  const verification = raw.verification;
  if (
    !isRecord(verification) ||
    typeof verification.lastChecked !== "string" ||
    !datePattern.test(verification.lastChecked)
  ) {
    fail("verification.lastChecked (YYYY-MM-DD) is required");
  } else if (verification.basis !== "official_text" && verification.basis !== "secondary_source") {
    fail("verification.basis must be official_text or secondary_source");
  }
  if (raw.appliesWhen !== undefined && !isRecord(raw.appliesWhen))
    fail("appliesWhen must be a mapping");
  if (raw.overrides !== undefined && typeof raw.overrides !== "boolean")
    fail("overrides must be true or false");
  if (
    raw.supersedes !== undefined &&
    (!Array.isArray(raw.supersedes) || !raw.supersedes.every((id) => typeof id === "string"))
  ) {
    fail("supersedes must be a list of ruleIds");
  }
  if (errors.length > 0) return { errors };

  const req = requirement as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  const ver = verification as Record<string, unknown>;
  const rule: LoadedRule = {
    ruleId: raw.ruleId as string,
    level: raw.level as RuleLevel,
    status: raw.status as RuleStatus,
    requirement: {
      kind: req.kind as string,
      ...(req.values ? { values: req.values as Record<string, unknown> } : {}),
    },
    source: {
      reference: src.reference as string,
      ...(typeof src.url === "string" ? { url: src.url } : {}),
      ...(typeof src.retrievedAt === "string" ? { retrievedAt: src.retrievedAt } : {}),
    },
    verification: {
      lastChecked: ver.lastChecked as string,
      basis: ver.basis as "official_text" | "secondary_source",
    },
    supersedes: (raw.supersedes as string[] | undefined) ?? [],
    origin,
    ...(raw.overrides === true ? { overrides: true } : {}),
    ...(isRecord(raw.authority) ? { authority: raw.authority } : {}),
    ...(isRecord(raw.document) ? { document: raw.document } : {}),
    ...(isRecord(raw.appliesWhen) ? { appliesWhen: raw.appliesWhen } : {}),
  };
  return { rule, errors: [] };
}

/** A rule file holds one rule, a list of rules, or a mapping with a top-level `rules` list. */
export function parseRuleFile(
  text: string,
  origin: RuleOrigin,
): { rules: LoadedRule[]; problems: PackProblem[] } {
  const problems: PackProblem[] = [];
  const rules: LoadedRule[] = [];
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const reason =
      error instanceof Error ? (error.message.split("\n")[0] ?? "invalid YAML") : "invalid YAML";
    return {
      rules,
      problems: [
        {
          code: "PCK-001",
          severity: "error",
          file: origin.file,
          message: `Invalid YAML: ${reason}`,
        },
      ],
    };
  }
  let entries: unknown[] | undefined;
  if (Array.isArray(document)) entries = document;
  else if (isRecord(document) && Array.isArray(document.rules)) entries = document.rules;
  else if (isRecord(document) && "ruleId" in document) entries = [document];
  if (!entries) {
    return {
      rules,
      problems: [
        {
          code: "POL-003",
          severity: "warning",
          file: origin.file,
          message:
            "Unrecognized file shape: expected a rule, a list of rules or a mapping with a rules list; file ignored",
        },
      ],
    };
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const { rule, errors } = parseRule(entry, origin);
    if (rule) {
      if (seen.has(rule.ruleId)) {
        problems.push({
          code: "PCK-001",
          severity: "error",
          file: origin.file,
          message: `Duplicate ruleId ${rule.ruleId} in the same file`,
        });
        continue;
      }
      seen.add(rule.ruleId);
      rules.push(rule);
    }
    for (const message of errors)
      problems.push({ code: "PCK-001", severity: "error", file: origin.file, message });
  }
  return { rules, problems };
}

export async function listYaml(directory: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive });
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join((entry as { parentPath?: string }).parentPath ?? directory, entry.name))
    .sort();
}

export async function readCapped(path: string): Promise<string> {
  if ((await stat(path)).size > maxFileBytes) throw new Error("File is larger than 512 KB");
  return readFile(path, "utf8");
}

export function relativeTo(root: string, absolute: string): string {
  return absolute
    .slice(root.length)
    .replace(/^[\\/]+/, "")
    .split("\\")
    .join("/");
}
