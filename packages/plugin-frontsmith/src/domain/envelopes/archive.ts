import { type EnvelopeResult, openEnvelope } from "./parse.js";

const RETRO_KEYS = [
  "escaped",
  "detectedBy",
  "ambiguities",
  "missingContext",
  "costlyChecks",
  "automationCandidates",
] as const;

export interface ArchiveEnvelope {
  schemaVersion: 1;
  kind: "archive";
  retrospective: Record<(typeof RETRO_KEYS)[number], string[]>;
  ruleCandidates: Array<{
    id: string;
    rationale: string;
    evidence: string[];
    /** Validated by the pack rule validator when the candidate is stored; invalid ones are dropped. */
    rule: Record<string, unknown>;
  }>;
}

export function validateArchive(raw: unknown): EnvelopeResult<ArchiveEnvelope> {
  const { check, root } = openEnvelope(raw, "archive", ["retrospective", "ruleCandidates"]);
  if (!root) return check.result(undefined as never);
  const retro = check.object(root.retrospective, "/retrospective", RETRO_KEYS);
  const retrospective = {} as ArchiveEnvelope["retrospective"];
  for (const key of RETRO_KEYS)
    retrospective[key] = retro ? check.strings(retro, key, "/retrospective") : [];
  const ruleCandidates = check.array(root, "ruleCandidates", "", (item, at) => {
    const c = check.object(item, at, ["id", "rationale", "evidence", "rule"]);
    if (!c) return undefined;
    const rule = check.object(c.rule, `${at}/rule`, Object.keys((c.rule as object) ?? {}));
    return {
      id: check.id(c, "id", at, "candidate") ?? "",
      rationale: check.string(c, "rationale", at) ?? "",
      evidence: check.strings(c, "evidence", at, { optional: true }),
      rule: rule ?? {},
    };
  });
  check.unique(ruleCandidates, "/ruleCandidates");
  return check.result({ schemaVersion: 1, kind: "archive", retrospective, ruleCandidates });
}
