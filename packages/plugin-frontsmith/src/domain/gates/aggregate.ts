import type { Severity } from "../severity.js";
import { severities } from "../severity.js";
import type { GateId } from "../state/feature-state.js";
import { aggregate, type Coverage, type Verdict } from "../verdict.js";

/** One deterministic check inside a gate (spec 10.2 `checks`). */
export interface GateCheck {
  id: string;
  status: Verdict;
  required: boolean;
  summary: string;
  /** Finding ids (`F-0001`), filled in when the report is built. */
  findings?: string[];
  logPath?: string;
}

/** A finding before its id is allocated; `check` names the check it belongs to. */
export interface DraftFinding {
  check: string;
  ruleId: string;
  severity: Severity;
  status: Verdict;
  kind: "deterministic" | "heuristic" | "agent";
  file?: string;
  line?: number;
  column?: number;
  message: string;
  fix?: string;
  source?: string;
}

export interface GateFinding extends Omit<DraftFinding, "check"> {
  id: string;
}

/** What each gate function returns: checks plus the findings that explain them. */
export interface GateOutcome {
  checks: GateCheck[];
  findings: DraftFinding[];
}

export interface GateReport {
  schema: "frontsmith.gate-report/v1";
  gate: GateId;
  feature: string;
  taskId?: string;
  verdict: Verdict;
  coverage: Coverage;
  checks: GateCheck[];
  findings: GateFinding[];
  generatedAt: string;
  tool: { name: "frontsmith"; version: string };
}

export interface BuildReportInput {
  gate: GateId;
  feature: string;
  taskId?: string;
  outcome: GateOutcome;
  generatedAt: string;
  version: string;
}

const compareDrafts = (a: DraftFinding, b: DraftFinding): number =>
  (a.file ?? "").localeCompare(b.file ?? "") ||
  (a.line ?? 0) - (b.line ?? 0) ||
  (a.column ?? 0) - (b.column ?? 0) ||
  a.ruleId.localeCompare(b.ruleId);

/**
 * Build the persisted report: finding ids `F-<4 digits>` are allocated in stable order (file, line,
 * column, rule id), checks list their finding ids, and the verdict is the precedence aggregation of
 * spec 10.1 (any FAIL, else a BLOCKED required check, else REVIEW, else PASS).
 */
export function buildGateReport(input: BuildReportInput): GateReport {
  const sorted = [...input.outcome.findings].sort(compareDrafts);
  const findings: GateFinding[] = sorted.map((draft, index) => {
    const { check: _check, ...rest } = draft;
    return { ...rest, id: `F-${String(index + 1).padStart(4, "0")}` };
  });
  const checks: GateCheck[] = input.outcome.checks.map((check) => {
    const ids = sorted
      .map((draft, index) => (draft.check === check.id ? (findings[index] as GateFinding).id : ""))
      .filter((id) => id !== "");
    return { ...check, ...(ids.length > 0 ? { findings: ids } : {}) };
  });
  const { verdict, coverage } = aggregate(checks);
  return {
    schema: "frontsmith.gate-report/v1",
    gate: input.gate,
    feature: input.feature,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    verdict,
    coverage,
    checks,
    findings,
    generatedAt: input.generatedAt,
    tool: { name: "frontsmith", version: input.version },
  };
}

// ---- helpers shared by the gate functions ----

export class GateBuilder {
  readonly outcome: GateOutcome = { checks: [], findings: [] };

  add(
    id: string,
    status: Verdict,
    summary: string,
    options: { required?: boolean; logPath?: string } = {},
  ): void {
    this.outcome.checks.push({
      id,
      status,
      required: options.required ?? true,
      summary,
      ...(options.logPath ? { logPath: options.logPath } : {}),
    });
  }

  finding(
    check: string,
    ruleId: string,
    severity: Severity,
    status: Verdict,
    message: string,
    extra: Partial<Pick<DraftFinding, "file" | "line" | "column" | "fix" | "source" | "kind">> = {},
  ): void {
    this.outcome.findings.push({
      check,
      ruleId,
      severity,
      status,
      kind: extra.kind ?? "deterministic",
      message,
      ...(extra.file !== undefined ? { file: extra.file } : {}),
      ...(extra.line !== undefined ? { line: extra.line } : {}),
      ...(extra.column !== undefined ? { column: extra.column } : {}),
      ...(extra.fix !== undefined ? { fix: extra.fix } : {}),
      ...(extra.source !== undefined ? { source: extra.source } : {}),
    });
  }

  /** A check whose status follows its findings: any problem is a FAIL (or `failStatus`), else PASS. */
  problems(
    id: string,
    ruleId: string,
    problems: readonly string[],
    okSummary: string,
    options: { severity?: Severity; failStatus?: Verdict; required?: boolean; fix?: string } = {},
  ): void {
    const status = options.failStatus ?? "FAIL";
    if (problems.length === 0) {
      this.add(
        id,
        "PASS",
        okSummary,
        options.required === undefined ? {} : { required: options.required },
      );
      return;
    }
    this.add(
      id,
      status,
      `${problems.length} problem${problems.length === 1 ? "" : "s"}`,
      options.required === undefined ? {} : { required: options.required },
    );
    for (const problem of problems)
      this.finding(id, ruleId, options.severity ?? "major", status, problem, {
        ...(options.fix ? { fix: options.fix } : {}),
      });
  }
}

export const isSeverityName = (value: string): value is Severity =>
  (severities as readonly string[]).includes(value);

/** A prepared check supplied by the application layer for the gates that wrap services (G6, G7). */
export interface Prepared {
  status: Verdict;
  summary: string;
  required?: boolean;
  logPath?: string;
  findings?: Array<Omit<DraftFinding, "check">>;
}

export function addPrepared(builder: GateBuilder, id: string, prepared: Prepared): void {
  builder.add(id, prepared.status, prepared.summary, {
    ...(prepared.required === undefined ? {} : { required: prepared.required }),
    ...(prepared.logPath ? { logPath: prepared.logPath } : {}),
  });
  for (const finding of prepared.findings ?? [])
    builder.outcome.findings.push({ ...finding, check: id });
}
