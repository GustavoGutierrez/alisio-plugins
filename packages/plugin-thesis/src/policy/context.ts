import type { Brief } from "../types.js";
import { appliesWhenKeys } from "./kinds.js";

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Facts a rule or a pack can be matched against. Resolved values are added in the second pass. */
export type MatchContext = Record<string, string | string[]>;

/** Brief-derived context. `studyDesign` and `domain` may carry several values. */
export function briefContext(brief: Brief): MatchContext {
  return {
    country: brief.institution.country,
    language: brief.language,
    workType: brief.workType,
    approach: brief.approach,
    studyDesign: brief.studyDesign ? [brief.studyDesign] : [],
    domain: [brief.domain.primary, ...brief.domain.secondary],
    aiUse: brief.aiUse.assisted ? "assisted" : "none",
  };
}

/** Renamed study designs that older pack drafts and the brief spell differently. */
const studyDesignAliases: Record<string, string[]> = {
  rct: ["randomized_trial"],
  randomized_trial: ["rct"],
  qualitative_interview: ["interviews_or_focus_groups"],
  interviews_or_focus_groups: ["qualitative_interview"],
  case_study: ["case_report"],
  case_report: ["case_study"],
};

function matchOne(key: string, expected: string, actual: string): boolean {
  if (key === "language")
    return expected === actual || expected.toLowerCase() === actual.split("-")[0]?.toLowerCase();
  if (key === "domain") return expected === actual || actual.startsWith(`${expected}_`);
  if (key === "studyDesign")
    return expected === actual || (studyDesignAliases[actual] ?? []).includes(expected);
  return expected === actual;
}

export interface MatchResult {
  ok: boolean;
  unknownKey?: string;
}

/**
 * All keys must match; a list value means any-of. `ethicsTrigger` is deferred (always satisfied)
 * until ethics answers exist: the ethics mapper filters on it. Keys listed in `deferred` pass too.
 */
export function matchesWhen(
  when: Record<string, unknown> | undefined,
  context: MatchContext,
  options: { deferred?: readonly string[]; unavailable?: readonly string[] } = {},
): MatchResult {
  for (const [key, expected] of Object.entries(when ?? {})) {
    if (!(appliesWhenKeys as readonly string[]).includes(key))
      return { ok: false, unknownKey: key };
    if (key === "ethicsTrigger" || options.deferred?.includes(key)) continue;
    if (options.unavailable?.includes(key)) return { ok: false };
    const actual = context[key];
    const actuals = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
    const wanted = (Array.isArray(expected) ? expected : [expected]).map(String);
    if (!wanted.some((candidate) => actuals.some((value) => matchOne(key, candidate, value)))) {
      return { ok: false };
    }
  }
  return { ok: true };
}
