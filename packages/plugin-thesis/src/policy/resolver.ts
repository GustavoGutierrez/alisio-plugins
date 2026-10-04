import { type Brief, shippedPresentationStandards } from "../types.js";
import { briefContext, type MatchContext, matchesWhen } from "./context.js";
import { exclusiveKinds } from "./kinds.js";
import type { LoadedPack } from "./packs.js";
import {
  type LoadedRule,
  listYaml,
  type PackProblem,
  type PolicyRule,
  parseRuleFile,
  type RuleLevel,
  type RuleOrigin,
  type RuleTier,
  readCapped,
} from "./rules.js";

export { crossValidate, type LoadedPack, loadPacks, selectPacks } from "./packs.js";
export {
  type LoadedRule,
  type PackProblem,
  type PolicyRule,
  parseRule,
  type RuleLevel,
  type RuleOrigin,
  type RuleTier,
  ruleLevels,
} from "./rules.js";

function tierForFile(name: string): RuleTier {
  const stem = name.replace(/\.ya?ml$/, "");
  if (stem === "institution" || stem === "faculty" || stem === "program" || stem === "rubric")
    return stem;
  if (stem.startsWith("template")) return "template";
  if (stem.startsWith("writing-")) return "writing-guide";
  return "other-override";
}

/** Load simple project overrides from `<root>/policy/*.yaml`. A missing directory is not an error. */
export async function loadOverrides(
  policyDirectory: string,
): Promise<{ rules: LoadedRule[]; problems: PackProblem[] }> {
  let files: string[];
  try {
    files = await listYaml(policyDirectory, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], problems: [] };
    throw error;
  }
  const rules: LoadedRule[] = [];
  const problems: PackProblem[] = [];
  for (const file of files) {
    const name = file.split(/[\\/]/).at(-1) ?? file;
    const origin: RuleOrigin = { tier: tierForFile(name), file: `policy/${name}` };
    let text: string;
    try {
      text = await readCapped(file);
    } catch (error) {
      problems.push({
        code: "PCK-001",
        severity: "error",
        file: origin.file,
        message: error instanceof Error ? error.message : "Unreadable file",
      });
      continue;
    }
    const parsed = parseRuleFile(text, origin);
    rules.push(...parsed.rules);
    problems.push(...parsed.problems);
  }
  return { rules, problems };
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** Lower rank wins. law, regulation, institution, faculty, program, rubric, template, style, default. */
const levelRank: Record<RuleLevel, number> = {
  LAW: 0,
  REGULATION: 1,
  INSTITUTIONAL_RULE: 2,
  PROGRAM_RULE: 4,
  TECHNICAL_STANDARD: 7,
  STYLE_GUIDE: 7,
  METHODOLOGY_GUIDELINE: 8,
  RECOMMENDATION: 8,
};
const tierRank: Partial<Record<RuleTier, number>> = {
  institution: 2,
  faculty: 3,
  program: 4,
  rubric: 5,
  template: 6,
  "writing-guide": 7,
};
const scopeRank: Partial<Record<string, number>> = { institution: 2, faculty: 3, program: 4 };
const FORCING_MAX_RANK = 6;
const DEFAULT_MIN_RANK = 8;

/**
 * Precedence by rule level and pack scope, never by load order. Laws and regulations keep their
 * level; other rules in institution, faculty and program packs rank by that scope (a `faculties/`
 * or `programs/` folder narrows it further); project override files rank by file name.
 */
export function ruleRank(rule: LoadedRule): number {
  const { origin } = rule;
  if (origin.tier !== "pack") return tierRank[origin.tier] ?? levelRank[rule.level];
  if (rule.level === "LAW" || rule.level === "REGULATION") return levelRank[rule.level];
  if (origin.program !== undefined) return 4;
  if (origin.faculty !== undefined) return 3;
  const byScope = origin.scope ? scopeRank[origin.scope] : undefined;
  return byScope !== undefined ? Math.min(byScope, levelRank[rule.level]) : levelRank[rule.level];
}

export interface ResolvedValue {
  value: string;
  source: "rule" | "brief" | "default" | "derived";
  ruleIds: string[];
  defaulted: boolean;
  note?: string;
}

export interface AppliedRule {
  ruleId: string;
  level: RuleLevel;
  rank: number;
  kind: string;
  values: Record<string, unknown>;
  appliesWhen: Record<string, unknown>;
  origin: RuleOrigin;
  source: PolicyRule["source"];
  verification: PolicyRule["verification"];
}

export interface ComplianceProfile {
  schemaVersion: 1;
  inputs: {
    language: string;
    country: string;
    workType: string;
    domain: string;
    approach: string;
    studyDesign: string | null;
    requestedCitationStyle: string;
    requestedPresentationStandard: string;
    aiDeclarationSetting: string;
  };
  packs: { id: string; version: string; scope: string; location: string }[];
  citationStyle: ResolvedValue;
  presentationStandard: ResolvedValue;
  aiDeclaration: {
    required: boolean;
    setting: "auto" | "always" | "never";
    ruleIds: string[];
    conflict?: string;
  };
  rules: AppliedRule[];
  superseded: { ruleId: string; supersededBy: string; reason: "precedence" | "supersedes" }[];
  /** Shipped rules that a deliberate `overrides: true` rule replaced; kept for the trail. */
  overridden: {
    ruleId: string;
    overriddenPack: string | null;
    overriddenFile: string;
    by: string;
    byFile: string;
  }[];
  conflicts: { kind: string; ruleIds: string[]; chosen: string; note: string; files: string[] }[];
  secondarySourceRuleIds: string[];
  warnings: string[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byRank = (a: LoadedRule, b: LoadedRule) =>
  ruleRank(a) - ruleRank(b) || compare(a.ruleId, b.ruleId);

function styleId(rule: LoadedRule): string | undefined {
  const id = rule.requirement.values?.id;
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(id) ? id : undefined;
}

function sameValues(a: LoadedRule, b: LoadedRule): boolean {
  return JSON.stringify(a.requirement.values ?? {}) === JSON.stringify(b.requirement.values ?? {});
}

export function resolve(
  brief: Brief,
  packs: readonly LoadedPack[],
  overrides: readonly LoadedRule[],
): ComplianceProfile {
  const warnings: string[] = [];
  const orderedPacks = [...packs].sort(
    (a, b) =>
      Number(a.scope !== "global") - Number(b.scope !== "global") ||
      compare(a.id, b.id) ||
      compare(a.location, b.location),
  );
  const everything = [...orderedPacks.flatMap((pack) => pack.rules), ...overrides].sort(
    (a, b) => compare(a.ruleId, b.ruleId) || compare(a.origin.file, b.origin.file),
  );

  // Same ruleId in several places: a deliberate `overrides: true` rule replaces the others.
  const overridden: ComplianceProfile["overridden"] = [];
  const unique: LoadedRule[] = [];
  const groups = new Map<string, LoadedRule[]>();
  for (const rule of everything)
    groups.set(rule.ruleId, [...(groups.get(rule.ruleId) ?? []), rule]);
  for (const [ruleId, group] of groups) {
    const replacing = group.filter((rule) => rule.overrides);
    const winner = replacing.at(-1) ?? (group[0] as LoadedRule);
    unique.push(winner);
    if (group.length > 1 && replacing.length === 0) {
      warnings.push(
        `Duplicate ruleId ${ruleId} in ${group.map((rule) => rule.origin.file).join(", ")}; the first definition is used`,
      );
    }
    for (const loser of group) {
      if (loser === winner || replacing.length === 0) continue;
      overridden.push({
        ruleId,
        overriddenPack: loser.origin.packId ?? null,
        overriddenFile: loser.origin.file,
        by: winner.origin.packId ?? winner.origin.tier,
        byFile: winner.origin.file,
      });
    }
  }

  const superseded: ComplianceProfile["superseded"] = [];
  const removed = new Set<string>();
  const active = unique.filter((rule) => rule.status === "active");
  for (const rule of active) {
    for (const target of rule.supersedes) {
      if (
        target !== rule.ruleId &&
        active.some((other) => other.ruleId === target) &&
        !removed.has(target)
      ) {
        removed.add(target);
        superseded.push({ ruleId: target, supersededBy: rule.ruleId, reason: "supersedes" });
      }
    }
  }
  const live = active.filter((rule) => !removed.has(rule.ruleId));

  const base: MatchContext = briefContext(brief);
  const unknownWarned = new Set<string>();
  const applies = (rule: LoadedRule, context: MatchContext, pass: 1 | 2): boolean => {
    const result = matchesWhen(rule.appliesWhen, context, {
      ...(pass === 1 ? { unavailable: ["presentationStandard", "citationStyle"] } : {}),
    });
    if (result.unknownKey && !unknownWarned.has(rule.ruleId)) {
      unknownWarned.add(rule.ruleId);
      warnings.push(
        `Rule ${rule.ruleId} uses unknown appliesWhen key "${result.unknownKey}" and never applies`,
      );
    }
    return result.ok;
  };

  const conflicts: ComplianceProfile["conflicts"] = [];
  const fileList = (rules: LoadedRule[]) => rules.map((rule) => rule.origin.file).sort();

  const resolveStyle = (
    kind: "citation_style" | "presentation_standard",
    requested: string,
    fallback: () => ResolvedValue,
  ): ResolvedValue => {
    const candidates = live
      .filter(
        (rule) =>
          rule.requirement.kind === kind && styleId(rule) !== undefined && applies(rule, base, 1),
      )
      .sort(byRank);
    const forcing = candidates.filter((rule) => ruleRank(rule) <= FORCING_MAX_RANK);
    const defaults = candidates.filter((rule) => ruleRank(rule) >= DEFAULT_MIN_RANK);
    const winner = forcing[0];
    if (winner) {
      const value = styleId(winner) as string;
      const tied = forcing.filter(
        (rule) => ruleRank(rule) === ruleRank(winner) && styleId(rule) !== value,
      );
      if (tied.length > 0) {
        conflicts.push({
          kind,
          ruleIds: [winner, ...tied].map((rule) => rule.ruleId).sort(),
          chosen: winner.ruleId,
          note: `Rules of equal precedence disagree on ${kind}; ${winner.ruleId} was chosen by ruleId order`,
          files: fileList([winner, ...tied]),
        });
      }
      const resolved: ResolvedValue = {
        value,
        source: "rule",
        ruleIds: [
          ...forcing.map((rule) => rule.ruleId),
          ...(requested === "auto" ? defaults.map((rule) => rule.ruleId) : []),
        ],
        defaulted: false,
      };
      if (requested !== "auto" && requested !== value) {
        const note = `The brief requested "${requested}" but ${winner.ruleId} (${winner.origin.packId ?? winner.origin.tier}) takes precedence`;
        resolved.note = note;
      }
      return resolved;
    }
    if (requested !== "auto") {
      return {
        value: requested,
        source: "brief",
        ruleIds: candidates
          .filter((rule) => styleId(rule) === requested)
          .map((rule) => rule.ruleId),
        defaulted: false,
      };
    }
    const fallbackDefault = defaults[0];
    if (fallbackDefault) {
      return {
        value: styleId(fallbackDefault) as string,
        source: "default",
        ruleIds: defaults.map((rule) => rule.ruleId),
        defaulted: true,
      };
    }
    return fallback();
  };

  const citationStyle = resolveStyle("citation_style", brief.citationStyle, () => ({
    value: "apa-7",
    source: "default",
    ruleIds: [],
    defaulted: true,
  }));
  if (citationStyle.defaulted) {
    warnings.push(
      `citationStyle was not set by a rule or by the user and defaults to ${citationStyle.value}; confirm it with your program`,
    );
  }
  const presentationStandard = resolveStyle(
    "presentation_standard",
    brief.presentation.standard,
    () => {
      const derived = (shippedPresentationStandards as readonly string[]).includes(
        citationStyle.value,
      )
        ? citationStyle.value
        : "generic";
      return {
        value: derived,
        source: derived === citationStyle.value ? "derived" : "default",
        ruleIds: [],
        defaulted: true,
      };
    },
  );
  if (presentationStandard.defaulted) {
    warnings.push(
      `presentation.standard was not set by a rule or by the user and defaults to ${presentationStandard.value}; confirm it with your program`,
    );
  }

  const context: MatchContext = {
    ...base,
    presentationStandard: presentationStandard.value,
    citationStyle: citationStyle.value,
  };
  const trail = new Set([...citationStyle.ruleIds, ...presentationStandard.ruleIds]);
  const applicable = live.filter(
    (rule) =>
      applies(rule, context, 2) &&
      (!["citation_style", "presentation_standard"].includes(rule.requirement.kind) ||
        trail.has(rule.ruleId)),
  );

  const winners: LoadedRule[] = [];
  const groupsByKind = new Map<string, LoadedRule[]>();
  for (const rule of applicable) {
    const kind = rule.requirement.kind;
    if (!exclusiveKinds.has(kind)) {
      winners.push(rule);
      continue;
    }
    groupsByKind.set(kind, [...(groupsByKind.get(kind) ?? []), rule]);
  }
  for (const [kind, list] of [...groupsByKind.entries()].sort()) {
    if (kind === "citation_style" || kind === "presentation_standard") {
      winners.push(...list);
      continue;
    }
    const sorted = [...list].sort(byRank);
    const winner = sorted[0] as LoadedRule;
    winners.push(winner);
    const tied = sorted.filter(
      (rule) => ruleRank(rule) === ruleRank(winner) && !sameValues(rule, winner),
    );
    if (tied.length > 0) {
      conflicts.push({
        kind,
        ruleIds: [winner, ...tied].map((rule) => rule.ruleId).sort(),
        chosen: winner.ruleId,
        note: `Rules of equal precedence disagree on ${kind}; ${winner.ruleId} was chosen by ruleId order`,
        files: fileList([winner, ...tied]),
      });
    }
    for (const loser of sorted.slice(1)) {
      superseded.push({ ruleId: loser.ruleId, supersededBy: winner.ruleId, reason: "precedence" });
    }
  }

  const rules: AppliedRule[] = winners.sort(byRank).map((rule) => ({
    ruleId: rule.ruleId,
    level: rule.level,
    rank: ruleRank(rule),
    kind: rule.requirement.kind,
    values: rule.requirement.values ?? {},
    appliesWhen: rule.appliesWhen ?? {},
    origin: rule.origin,
    source: rule.source,
    verification: rule.verification,
  }));

  const aiRule = rules.find((rule) => rule.kind === "ai_declaration");
  const policyRequires = aiRule?.values.required === true;
  const setting = brief.aiUse.declaration;
  const aiDeclaration: ComplianceProfile["aiDeclaration"] = {
    required: setting === "always" || policyRequires,
    setting,
    ruleIds: aiRule ? [aiRule.ruleId] : [],
  };
  if (setting === "never" && policyRequires) {
    aiDeclaration.conflict = `aiUse.declaration is "never" but ${aiRule?.ruleId} requires an AI-use declaration; the build will reject it`;
  }

  return {
    schemaVersion: 1,
    inputs: {
      language: brief.language,
      country: brief.institution.country,
      workType: brief.workType,
      domain: brief.domain.primary,
      approach: brief.approach,
      studyDesign: brief.studyDesign,
      requestedCitationStyle: brief.citationStyle,
      requestedPresentationStandard: brief.presentation.standard,
      aiDeclarationSetting: setting,
    },
    packs: orderedPacks.map((pack) => ({
      id: pack.id,
      version: pack.version,
      scope: pack.scope,
      location: pack.location,
    })),
    citationStyle,
    presentationStandard,
    aiDeclaration,
    rules,
    superseded: superseded.sort((a, b) => compare(a.ruleId, b.ruleId)),
    overridden: overridden.sort((a, b) => compare(a.ruleId, b.ruleId)),
    conflicts: conflicts.sort((a, b) => compare(a.kind + a.chosen, b.kind + b.chosen)),
    secondarySourceRuleIds: rules
      .filter((rule) => rule.verification.basis === "secondary_source")
      .map((rule) => rule.ruleId)
      .sort(),
    warnings: [...new Set(warnings)].sort(),
  };
}
