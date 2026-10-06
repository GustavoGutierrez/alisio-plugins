import type { BudgetCheckResult } from "../../application/checks/budget-check.js";
import type { DoctorItem } from "../../application/services.js";
import type { NextOutcome } from "../../application/workflow/coordinator.js";
import type { UnitResult } from "../../application/workflow/env.js";
import type { NextAction } from "../../application/workflow/status.js";
import type { GateReport } from "../../domain/gates/aggregate.js";
import type { FeatureState } from "../../domain/state/feature-state.js";
import { approvalsForLevel, phasesForLevel } from "../../domain/state/levels.js";
import { capOutput, code, table } from "./markdown.js";

const BAR: Record<string, string> = { done: "done", current: "current", todo: "todo" };

/** The progress of a feature through its phases, gates, tasks and approvals (spec Appendix A `status`). */
export function statusMarkdown(
  state: FeatureState,
  next: NextAction,
  options: { readOnly: boolean; running: boolean; artifactDir: string },
): string {
  const phases = phasesForLevel(state.level, {
    tokensNeeded: state.artifacts.tokens !== undefined || state.phase === "tokens",
  });
  const index = phases.indexOf(state.phase);
  const rows = phases.map((phase, i) => [
    phase,
    BAR[i < index || state.phase === "closed" ? "done" : i === index ? "current" : "todo"] ?? "",
  ]);
  const lines = [
    `## ${state.feature} (${state.level}, ${state.mode})`,
    "",
    `Phase: ${code(state.phase)}${options.running ? " (a job is running)" : ""}${options.readOnly ? " (read-only: written by a newer Frontsmith)" : ""}`,
    `Intent: ${state.intent}`,
    "",
    table(["phase", "state"], rows),
  ];
  const gates = Object.entries(state.gates);
  if (gates.length > 0)
    lines.push(
      "",
      "### Gates",
      "",
      table(
        ["gate", "verdict", "report"],
        gates.map(([id, g]) => [id, g.verdict, code(g.reportPath)]),
      ),
    );
  if (state.tasks.length > 0)
    lines.push(
      "",
      "### Tasks",
      "",
      table(
        ["task", "layer", "origin", "status", "bounces", "gate"],
        state.tasks.map((t) => [
          t.id,
          t.layer,
          t.origin,
          t.status,
          String(t.bounces),
          t.lastGate?.verdict ?? "-",
        ]),
      ),
    );
  const approvals = approvalsForLevel(state.level);
  if (approvals.length > 0) {
    const slot = {
      spec: "spec",
      "ui-contract": "uiContract",
      plan: "plan",
      acceptance: "acceptance",
      "review-signoff": "reviewSignoff",
    } as const;
    lines.push(
      "",
      "### Approvals",
      "",
      table(
        ["approval", "state"],
        approvals.map((a) => [
          a,
          state.approvals[slot[a]]
            ? `approved ${state.approvals[slot[a]]?.at.slice(0, 10)}`
            : "pending",
        ]),
      ),
    );
  }
  const open = state.questions.filter((q) => !q.answer);
  if (open.length > 0)
    lines.push(
      "",
      "### Open questions",
      "",
      ...open.map((q) => `- ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}`),
    );
  const artifacts = Object.values(state.artifacts)
    .map((a) => a.path)
    .filter((p) => /\.md$/.test(p));
  if (artifacts.length > 0)
    lines.push("", "### Artifacts", "", ...artifacts.map((p) => `- ${code(p)}`));
  if (state.blocked) lines.push("", `**Blocked:** ${state.blocked.reason}`);
  lines.push("", `**Next:** ${next.message} Run ${code(next.command)}`);
  return capOutput(lines.join("\n"), `Full state: ${options.artifactDir}.`);
}

export function featureListMarkdown(states: readonly FeatureState[]): string {
  if (states.length === 0)
    return "No features yet. Create one with `/frontsmith:new <feature> --level L0|L1|L2|L3 -- <intent>`.";
  return [
    `## Features (${states.length})`,
    "",
    table(
      ["feature", "level", "phase", "intent"],
      states.map((s) => [s.feature, s.level, s.phase, s.intent.slice(0, 80)]),
    ),
  ].join("\n");
}

const unitLine = (result: UnitResult): string => {
  switch (result.kind) {
    case "advanced":
      return result.message;
    case "waiting":
      return `${result.message}\n\nRun ${code(result.command)}`;
    case "blocked":
      return `Blocked${result.gate ? ` at ${result.gate}` : ""}: ${result.message}`;
    case "closed":
      return result.message;
    case "cancelled":
      return result.message;
  }
};

export function nextMarkdown(outcome: NextOutcome, feature: string): string {
  if (outcome.kind === "job-started")
    return `Started job ${code(outcome.id)} for the ${outcome.unit} unit. Follow with ${code(`/frontsmith:status ${feature}`)}; stop it with ${code(`/frontsmith:stop ${feature}`)}.`;
  return [
    `## ${feature}: ${outcome.unit}`,
    "",
    unitLine(outcome.result),
    "",
    `Next: ${code(outcome.next.command)}`,
  ].join("\n");
}

const MARK: Record<string, string> = {
  PASS: "pass",
  FAIL: "FAIL",
  REVIEW: "review",
  BLOCKED: "BLOCKED",
  SKIPPED: "skipped",
};

export function gateReportMarkdown(report: GateReport, reportPath?: string): string {
  const lines = [
    `## ${report.gate}${report.taskId ? ` ${report.taskId}` : ""}: ${report.verdict}`,
    "",
    `Coverage: ${report.coverage.executed} of ${report.coverage.required} required checks evidenced${report.coverage.pending > 0 ? `, ${report.coverage.pending} pending` : ""}.`,
    "",
    table(
      ["check", "status", "summary"],
      report.checks.map((c) => [c.id, MARK[c.status] ?? c.status, c.summary]),
    ),
  ];
  const shown = report.findings.filter(
    (f) => f.status === "FAIL" || f.status === "BLOCKED" || f.status === "REVIEW",
  );
  if (shown.length > 0)
    lines.push(
      "",
      "### Findings",
      "",
      table(
        ["id", "rule", "severity", "location", "message"],
        shown
          .slice(0, 60)
          .map((f) => [
            f.id,
            f.ruleId,
            f.severity,
            f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "-",
            f.message,
          ]),
      ),
    );
  if (reportPath) lines.push("", `Report: ${code(reportPath)}`);
  return capOutput(
    lines.join("\n"),
    reportPath ? `Full report: ${reportPath}.` : "Use --json for the full report.",
  );
}

export function doctorMarkdown(items: readonly DoctorItem[]): string {
  const bad = items.filter((i) => i.status === "FAIL" || i.status === "BLOCKED").length;
  return [
    `## Doctor: ${bad === 0 ? "ready" : `${bad} problem${bad === 1 ? "" : "s"}`}`,
    "",
    table(
      ["check", "status", "detail"],
      items.map((i) => [i.name, MARK[i.status] ?? i.status, i.detail]),
    ),
  ].join("\n");
}

export function budgetMarkdown(result: BudgetCheckResult): string {
  if (result.status === "SKIPPED")
    return "No `.frontsmith/budgets.json`: no budgets are checked (no universal numbers are invented).";
  const lines = [`## Budgets: ${result.status}`, ""];
  if (result.lines.length > 0)
    lines.push(
      table(
        ["budget", "status", "summary"],
        result.lines.map((l) => [l.id, MARK[l.status] ?? l.status, l.summary]),
      ),
    );
  if (result.problems.length > 0)
    lines.push("", "Problems:", ...result.problems.map((p) => `- ${p}`));
  if (result.findings.length > 0)
    lines.push(
      "",
      table(
        ["rule", "location", "message"],
        result.findings.map((f) => [f.ruleId, f.file ?? "-", f.message]),
      ),
    );
  return lines.join("\n");
}
