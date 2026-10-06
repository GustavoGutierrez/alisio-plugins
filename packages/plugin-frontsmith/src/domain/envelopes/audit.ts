import { type EnvelopeResult, openEnvelope } from "./parse.js";

export const reviewSeverities = ["BLOCKER", "MAJOR", "MINOR", "NIT"] as const;
export type ReviewSeverity = (typeof reviewSeverities)[number];
const RULE_REF = /^[A-Za-z][A-Za-z0-9-]{1,79}$/;
const WCAG = /^[1-4]\.\d{1,2}\.\d{1,2}$/;

export interface AuditEnvelope {
  schemaVersion: 1;
  kind: "a11y-audit";
  findings: Array<{
    ruleRef: string;
    wcag: string;
    severity: ReviewSeverity;
    location: { file: string; line: number };
    caseId: string | null;
    elementId: string | null;
    evidence: string;
    fix: string;
    status: "fail" | "review";
  }>;
  manualChecks: Array<{
    criterion: string;
    procedure: string;
    result: "pass" | "fail" | "not-run";
    evidence: string;
  }>;
}

export function validateAudit(raw: unknown): EnvelopeResult<AuditEnvelope> {
  const { check, root } = openEnvelope(raw, "a11y-audit", ["findings", "manualChecks"]);
  if (!root) return check.result(undefined as never);
  const findings = check.array(root, "findings", "", (item, at) => {
    const f = check.object(item, at, [
      "ruleRef",
      "wcag",
      "severity",
      "location",
      "caseId",
      "elementId",
      "evidence",
      "fix",
      "status",
    ]);
    if (!f) return undefined;
    const location = check.object(f.location, `${at}/location`, ["file", "line"]);
    return {
      ruleRef: check.string(f, "ruleRef", at, { pattern: RULE_REF }) ?? "",
      wcag: check.string(f, "wcag", at, { pattern: WCAG }) ?? "",
      severity: check.enum(f, "severity", at, reviewSeverities) ?? "MINOR",
      location: {
        file: location ? (check.path(location, "file", `${at}/location`) ?? "") : "",
        line: location
          ? (check.number(location, "line", `${at}/location`, { integer: true, min: 1 }) ?? 1)
          : 1,
      },
      caseId: check.string(f, "caseId", at, { nullable: true, optional: true, max: 48 }) ?? null,
      elementId:
        check.string(f, "elementId", at, { nullable: true, optional: true, max: 48 }) ?? null,
      evidence: check.string(f, "evidence", at) ?? "",
      fix: check.string(f, "fix", at) ?? "",
      status: check.enum(f, "status", at, ["fail", "review"] as const) ?? "fail",
    };
  });
  const manualChecks = check.array(root, "manualChecks", "", (item, at) => {
    const m = check.object(item, at, ["criterion", "procedure", "result", "evidence"]);
    if (!m) return undefined;
    return {
      criterion: check.string(m, "criterion", at) ?? "",
      procedure: check.string(m, "procedure", at) ?? "",
      result: check.enum(m, "result", at, ["pass", "fail", "not-run"] as const) ?? "not-run",
      evidence: check.string(m, "evidence", at, { allowEmpty: true }) ?? "",
    };
  });
  return check.result({ schemaVersion: 1, kind: "a11y-audit", findings, manualChecks });
}
