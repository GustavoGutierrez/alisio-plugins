import type { Severity } from "./severity.js";

/** Check result statuses and the aggregation rules of spec 10.1. */
export const verdicts = ["PASS", "FAIL", "REVIEW", "BLOCKED", "SKIPPED"] as const;
export type Verdict = (typeof verdicts)[number];
export type CheckStatus = Verdict;

export type RuleKind = "deterministic" | "heuristic" | "advisory";

export interface FindingStatusOptions {
  waived?: boolean;
  suppressed?: boolean;
}

/**
 * Status of one finding. Deterministic blocker/major => FAIL, minor => REVIEW, nit => PASS with a
 * note. Heuristic rules produce at most REVIEW. A waiver or a valid suppression resolves to PASS
 * (the note travels with the finding).
 */
export function statusForFinding(
  severity: Severity,
  kind: RuleKind,
  options: FindingStatusOptions = {},
): Verdict {
  if (options.waived || options.suppressed) return "PASS";
  if (severity === "nit") return "PASS";
  if (severity === "minor") return "REVIEW";
  return kind === "deterministic" ? "FAIL" : "REVIEW";
}

export interface AggregateInput {
  status: CheckStatus;
  required: boolean;
}

export interface Coverage {
  required: number;
  executed: number;
  pending: number;
}

/**
 * Precedence aggregation, never an average: any FAIL => FAIL; else a BLOCKED required check =>
 * BLOCKED; else any REVIEW => REVIEW; else PASS. SKIPPED checks never count as evidence.
 * Coverage counts required, non-skipped checks: `executed` produced evidence, `pending` are BLOCKED.
 * An empty list is BLOCKED because nothing was evidenced.
 */
export function aggregate(checks: readonly AggregateInput[]): {
  verdict: Verdict;
  coverage: Coverage;
} {
  const counted = checks.filter((check) => check.required && check.status !== "SKIPPED");
  const pending = counted.filter((check) => check.status === "BLOCKED").length;
  const coverage: Coverage = {
    required: counted.length,
    executed: counted.length - pending,
    pending,
  };
  if (checks.length === 0) return { verdict: "BLOCKED", coverage };
  if (checks.some((check) => check.status === "FAIL")) return { verdict: "FAIL", coverage };
  if (pending > 0) return { verdict: "BLOCKED", coverage };
  if (checks.some((check) => check.status === "REVIEW")) return { verdict: "REVIEW", coverage };
  return { verdict: "PASS", coverage };
}
