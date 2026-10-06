import { type ReviewSeverity, reviewSeverities } from "./audit.js";
import { type EnvelopeResult, openEnvelope } from "./parse.js";

export const reviewDimensions = [
  "correctness",
  "architecture",
  "ux-a11y",
  "quality",
  "risk",
  "performance",
] as const;
export type ReviewDimension = (typeof reviewDimensions)[number];
export type ReviewVerdict = "changes-requested" | "approved";

export interface ReviewEnvelope {
  schemaVersion: 1;
  kind: "review";
  findings: Array<{
    dimension: ReviewDimension;
    severity: ReviewSeverity;
    file: string;
    line: number;
    claim: string;
    evidence: string;
    fix: string;
    acRef: string | null;
  }>;
  verdict: ReviewVerdict;
}

/** Code recomputes the verdict: changes are requested iff any BLOCKER or MAJOR is open (spec 9.2). */
export function reviewVerdict(
  findings: ReadonlyArray<{ severity: ReviewSeverity }>,
): ReviewVerdict {
  return findings.some((f) => f.severity === "BLOCKER" || f.severity === "MAJOR")
    ? "changes-requested"
    : "approved";
}

export function validateReview(raw: unknown): EnvelopeResult<ReviewEnvelope> {
  const { check, root } = openEnvelope(raw, "review", ["findings", "verdict"]);
  if (!root) return check.result(undefined as never);
  const findings = check.array(root, "findings", "", (item, at) => {
    const f = check.object(item, at, [
      "dimension",
      "severity",
      "file",
      "line",
      "claim",
      "evidence",
      "fix",
      "acRef",
    ]);
    if (!f) return undefined;
    return {
      dimension: check.enum(f, "dimension", at, reviewDimensions) ?? "correctness",
      severity: check.enum(f, "severity", at, reviewSeverities) ?? "MINOR",
      file: check.path(f, "file", at) ?? "",
      line: check.number(f, "line", at, { integer: true, min: 1 }) ?? 1,
      claim: check.string(f, "claim", at) ?? "",
      evidence: check.string(f, "evidence", at) ?? "",
      fix: check.string(f, "fix", at) ?? "",
      acRef:
        f.acRef === null || f.acRef === undefined
          ? null
          : (check.id(f, "acRef", at, "acceptance") ?? null),
    };
  });
  const verdict = check.enum(root, "verdict", "", ["changes-requested", "approved"] as const);
  if (verdict !== undefined && verdict !== reviewVerdict(findings))
    check.fail("/verdict", `does not match the findings (expected ${reviewVerdict(findings)})`);
  return check.result({
    schemaVersion: 1,
    kind: "review",
    findings,
    verdict: verdict ?? reviewVerdict(findings),
  });
}
