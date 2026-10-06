import type { DraftFinding, Prepared } from "../../domain/gates/aggregate.js";
import type { Finding } from "../../domain/rules/model.js";
import type { Verdict } from "../../domain/verdict.js";
import type { ArchitectureCheckResult } from "../checks/architecture-check.js";
import type { RulesCheckResult } from "../checks/rules-check.js";

const draft = (finding: Finding): Omit<DraftFinding, "check"> => ({
  ruleId: finding.ruleId,
  severity: finding.severity,
  status: finding.status,
  kind: finding.kind === "deterministic" ? "deterministic" : "heuristic",
  file: finding.file,
  line: finding.line,
  column: finding.column,
  message: finding.message,
  ...(finding.fix ? { fix: finding.fix } : {}),
  ...(finding.source ? { source: finding.source } : {}),
});

const open = (finding: Finding): boolean =>
  finding.status === "FAIL" || finding.status === "REVIEW";

/** A rules run as a gate check; `exclude` removes rule ids another check reports (FS-GOV-005). */
export function rulesPrepared(
  result: RulesCheckResult,
  exclude: ReadonlySet<string> = new Set(),
): Prepared {
  const findings = result.findings.filter((f) => open(f) && !exclude.has(f.ruleId));
  const failing = findings.some((f) => f.status === "FAIL");
  const status: Verdict = failing
    ? "FAIL"
    : result.verdict === "BLOCKED"
      ? "BLOCKED"
      : findings.some((f) => f.status === "REVIEW")
        ? "REVIEW"
        : result.verdict === "SKIPPED"
          ? "SKIPPED"
          : "PASS";
  return {
    status,
    summary: `${result.checks.length} rules checked, ${findings.length} open finding${findings.length === 1 ? "" : "s"}`,
    findings: findings.map(draft),
  };
}

/** Only the findings of the given rule ids, as their own check (the scope guard FS-GOV-005). */
export function onlyRules(
  result: RulesCheckResult,
  ids: ReadonlySet<string>,
  label: string,
): Prepared {
  const findings = result.findings.filter((f) => open(f) && ids.has(f.ruleId));
  const failing = findings.some((f) => f.status === "FAIL");
  return {
    status: failing ? "FAIL" : findings.length > 0 ? "REVIEW" : "PASS",
    summary:
      findings.length === 0
        ? `${label}: no findings`
        : `${label}: ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    findings: findings.map(draft),
  };
}

export function architecturePrepared(result: ArchitectureCheckResult): Prepared {
  const findings = result.violations.map((v) => ({
    ruleId: v.ruleId,
    severity: v.severity,
    status: (v.severity === "minor" ? "REVIEW" : "FAIL") as Verdict,
    kind: "deterministic" as const,
    file: v.file,
    line: v.line,
    column: v.column,
    message: `${v.check}: ${v.detail}`,
  }));
  const status: Verdict = findings.some((f) => f.status === "FAIL")
    ? "FAIL"
    : findings.length > 0
      ? "REVIEW"
      : "PASS";
  return {
    status,
    summary: `${result.filesChecked} files checked, ${findings.length} violation${findings.length === 1 ? "" : "s"}`,
    findings,
  };
}

export const blockedPrepared = (summary: string, ruleId = "G-BLOCKED"): Prepared => ({
  status: "BLOCKED",
  summary,
  findings: [
    { ruleId, severity: "blocker", status: "BLOCKED", kind: "deterministic", message: summary },
  ],
});

/** Test files by convention: `*.test.*`, `*.spec.*`, or under a tests, __tests__ or e2e directory. */
export const isTestPath = (path: string): boolean =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:__tests__|tests?|e2e)\//.test(path);
