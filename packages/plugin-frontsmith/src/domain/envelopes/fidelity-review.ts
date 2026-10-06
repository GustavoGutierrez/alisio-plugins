import { type EnvelopeResult, openEnvelope } from "./parse.js";

export const fidelityVerdicts = [
  "defect",
  "acceptable-variation",
  "reference-conflict",
  "needs-human",
] as const;
export type FidelityVerdict = (typeof fidelityVerdicts)[number];

export interface FidelityReviewEnvelope {
  schemaVersion: 1;
  kind: "fidelity-review";
  classifications: Array<{ findingId: string; verdict: FidelityVerdict; rationale: string }>;
  repairPlan: Array<{ order: number; cause: string; files: string[]; findingIds: string[] }>;
  designCritique: Array<{ signal: string; region: string; effect: string; proposal: string }>;
}

/** What the coordinator knows about each finding the reviewer may classify. */
export interface FidelityReviewContext {
  /** Status of every finding shown to the reviewer; classifying an unknown id is invalid. */
  findings: Readonly<Record<string, "FAIL" | "REVIEW">>;
}

/**
 * Only REVIEW items may be classified `acceptable-variation` or `reference-conflict`; a FAIL can
 * only be a `defect` or `needs-human` (spec 5.3, B-23).
 */
export function validateFidelityReview(
  raw: unknown,
  context?: FidelityReviewContext,
): EnvelopeResult<FidelityReviewEnvelope> {
  const { check, root } = openEnvelope(raw, "fidelity-review", [
    "classifications",
    "repairPlan",
    "designCritique",
  ]);
  if (!root) return check.result(undefined as never);
  const classifications = check.array(root, "classifications", "", (item, at) => {
    const c = check.object(item, at, ["findingId", "verdict", "rationale"]);
    if (!c) return undefined;
    const findingId = check.string(c, "findingId", at, { pattern: /^F-\d{4}$/ }) ?? "";
    const verdict = check.enum(c, "verdict", at, fidelityVerdicts) ?? "needs-human";
    if (context && findingId) {
      const status = context.findings[findingId];
      if (status === undefined) check.fail(`${at}/findingId`, `unknown finding ${findingId}`);
      else if (
        status === "FAIL" &&
        (verdict === "acceptable-variation" || verdict === "reference-conflict")
      )
        check.fail(`${at}/verdict`, `a FAIL finding cannot be classified ${verdict}`);
    }
    return { findingId, verdict, rationale: check.string(c, "rationale", at) ?? "" };
  });
  const repairPlan = check.array(root, "repairPlan", "", (item, at) => {
    const r = check.object(item, at, ["order", "cause", "files", "findingIds"]);
    if (!r) return undefined;
    return {
      order: check.number(r, "order", at, { integer: true, min: 1 }) ?? 1,
      cause: check.string(r, "cause", at) ?? "",
      files: check.strings(r, "files", at, { path: true }),
      findingIds: check.strings(r, "findingIds", at, { pattern: /^F-\d{4}$/ }),
    };
  });
  const designCritique = check.array(root, "designCritique", "", (item, at) => {
    const d = check.object(item, at, ["signal", "region", "effect", "proposal"]);
    if (!d) return undefined;
    return {
      signal: check.string(d, "signal", at, { pattern: /^AV\d\d$/ }) ?? "",
      region: check.string(d, "region", at, { max: 80 }) ?? "",
      effect: check.string(d, "effect", at) ?? "",
      proposal: check.string(d, "proposal", at) ?? "",
    };
  });
  return check.result({
    schemaVersion: 1,
    kind: "fidelity-review",
    classifications,
    repairPlan,
    designCritique,
  });
}
