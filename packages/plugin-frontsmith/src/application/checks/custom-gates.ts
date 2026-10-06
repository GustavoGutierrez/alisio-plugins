import type { CustomGateConfig } from "../../domain/config/defaults.js";
import type { DraftFinding, Prepared } from "../../domain/gates/aggregate.js";
import { isSeverityName } from "../../domain/gates/aggregate.js";
import { type Verdict, verdicts } from "../../domain/verdict.js";
import { type CommandDeps, runProjectCommand } from "./commands-check.js";

export interface RunCustomGatesInput {
  root: string;
  gates: readonly CustomGateConfig[];
  phase: "build" | "validate";
  defaultTimeoutMs: number;
  /** Workspace-relative evidence directory for the gate logs. */
  logDir: string;
  signal?: AbortSignal;
  /** Set while FS-GOV-001 is open: custom gates never run (spec 17.3). */
  refuse?: string;
}

export interface CustomGateResult {
  id: string;
  prepared: Prepared;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type GateReportParse =
  | { ok: true; verdict: Verdict; summary: string; findings: Array<Omit<DraftFinding, "check">> }
  | { ok: false; reason: string };

/** `frontsmith.gate-report/v1` as emitted by a custom gate (spec 10.2, 17.3). */
export function validateGateReportJson(raw: unknown): GateReportParse {
  if (!isRecord(raw) || raw.schema !== "frontsmith.gate-report/v1")
    return { ok: false, reason: "not a frontsmith.gate-report/v1 document" };
  if (typeof raw.verdict !== "string" || !(verdicts as readonly string[]).includes(raw.verdict))
    return { ok: false, reason: "verdict is not PASS, FAIL, REVIEW, BLOCKED or SKIPPED" };
  if (!Array.isArray(raw.checks) || !Array.isArray(raw.findings))
    return { ok: false, reason: "checks and findings must be arrays" };
  const findings: Array<Omit<DraftFinding, "check">> = [];
  for (const item of raw.findings.slice(0, 200)) {
    if (!isRecord(item) || typeof item.message !== "string") continue;
    findings.push({
      ruleId: typeof item.ruleId === "string" ? item.ruleId.slice(0, 64) : "CUSTOM",
      severity:
        typeof item.severity === "string" && isSeverityName(item.severity)
          ? item.severity
          : "major",
      status:
        typeof item.status === "string" && (verdicts as readonly string[]).includes(item.status)
          ? (item.status as Verdict)
          : "FAIL",
      kind: "deterministic",
      message: item.message.slice(0, 1000),
      ...(typeof item.file === "string" ? { file: item.file } : {}),
      ...(typeof item.line === "number" ? { line: item.line } : {}),
      ...(typeof item.column === "number" ? { column: item.column } : {}),
    });
  }
  return {
    ok: true,
    verdict: raw.verdict as Verdict,
    summary: `${raw.checks.length} check${raw.checks.length === 1 ? "" : "s"}, ${raw.findings.length} finding${raw.findings.length === 1 ? "" : "s"}`,
    findings,
  };
}

/** Run the configured custom gates of one phase as external processes (AD-5, spec 17.3). */
export async function runCustomGates(
  deps: CommandDeps,
  input: RunCustomGatesInput,
): Promise<CustomGateResult[]> {
  const results: CustomGateResult[] = [];
  for (const gate of input.gates.filter((g) => g.phase === input.phase)) {
    const required = gate.required !== false;
    const blocked = (summary: string): CustomGateResult => ({
      id: gate.id,
      prepared: {
        status: "BLOCKED",
        summary,
        required,
        findings: [
          {
            ruleId: "GATE-CUSTOM",
            severity: "blocker",
            status: "BLOCKED",
            kind: "deterministic",
            message: `${gate.id}: ${summary}`,
          },
        ],
      },
    });
    if (input.refuse) {
      results.push(blocked(`refused: ${input.refuse}`));
      continue;
    }
    const outcome = await runProjectCommand(deps, {
      root: input.root,
      name: gate.id,
      argv: gate.command,
      source: "config",
      timeoutMs: gate.timeoutMs ?? input.defaultTimeoutMs,
      logPath: `${input.logDir}/custom-${gate.id}.log`,
      captureStdout: gate.report === "frontsmith-json",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (outcome.status === "BLOCKED") {
      results.push(blocked(outcome.summary));
      continue;
    }
    const log = outcome.logPath ? { logPath: outcome.logPath } : {};
    if (gate.report === "exit-code") {
      if (outcome.status === "PASS")
        results.push({
          id: gate.id,
          prepared: { status: "PASS", summary: outcome.summary, required, ...log },
        });
      else {
        const status: Verdict = required ? "FAIL" : "REVIEW";
        results.push({
          id: gate.id,
          prepared: {
            status,
            summary: outcome.summary,
            required,
            ...log,
            findings: [
              {
                ruleId: "GATE-CUSTOM",
                severity: gate.severity ?? "major",
                status,
                kind: "deterministic",
                message: `${gate.id}: ${outcome.evidence ?? outcome.summary}`.slice(0, 4400),
              },
            ],
          },
        });
      }
      continue;
    }
    results.push(jsonResult(gate, outcome.stdout, required, blocked));
  }
  return results;
}

/** `report: frontsmith-json`: stdout must be one gate report; anything else is BLOCKED. */
function jsonResult(
  gate: CustomGateConfig,
  stdout: string | undefined,
  required: boolean,
  blocked: (summary: string) => CustomGateResult,
): CustomGateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse((stdout ?? "").trim());
  } catch {
    return blocked("the gate did not print one frontsmith.gate-report/v1 JSON document");
  }
  const report = validateGateReportJson(parsed);
  if (!report.ok) return blocked(report.reason);
  return {
    id: gate.id,
    prepared: {
      status: report.verdict,
      summary: report.summary,
      required,
      findings: report.findings,
    },
  };
}
