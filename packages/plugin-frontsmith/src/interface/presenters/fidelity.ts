import type { TestCaseResult, UiBlock } from "@alisio/sdk";
import type { BaselineMeta } from "../../application/checks/fidelity-run.js";
import type { A11yReport } from "../../domain/fidelity/a11y.js";
import type { CalibrationFile, ValidatorQuality } from "../../domain/fidelity/calibration.js";
import type { FidelityReport } from "../../domain/fidelity/evaluate.js";
import { capOutput, code, table } from "./markdown.js";

const status = (verdict: string): TestCaseResult["status"] =>
  verdict === "PASS"
    ? "passed"
    : verdict === "FAIL" || verdict === "BLOCKED"
      ? "failed"
      : verdict === "REVIEW" || verdict === "UNSEPARABLE"
        ? "todo"
        : "skipped";

/** Test results: suites are cases, cases are the failing or reviewed rules (all passing ones are one line). */
export function fidelityBlock(report: FidelityReport): UiBlock {
  const byCase = new Map<string, TestCaseResult[]>();
  for (const failure of report.failures) {
    const list = byCase.get(failure.caseId) ?? [];
    list.push({
      name: `${failure.ruleId} ${failure.elementId}.${failure.property}`,
      status: status(failure.status),
      error: `expected ${String(failure.expected)}${failure.actual === null ? "" : `, actual ${String(failure.actual)}`}${failure.note ? ` (${failure.note})` : ""}`,
    });
    byCase.set(failure.caseId, list);
  }
  const suites = [...byCase].map(([name, cases]) => ({ name, cases }));
  if (suites.length === 0)
    suites.push({
      name: "fidelity",
      cases: [
        {
          name:
            report.status === "PASS"
              ? "every required rule"
              : (report.blockers[0] ?? "no evidence"),
          status: status(report.status),
        },
      ],
    });
  return { kind: "test-results", framework: "frontsmith", suites };
}

export function fidelityTable(report: FidelityReport): UiBlock {
  return {
    kind: "table",
    columns: [
      "id",
      "rule",
      "case",
      "element",
      "property",
      "expected",
      "actual",
      "error",
      "tolerance",
      "severity",
      "status",
    ],
    rows: report.failures.map((f) => [
      f.id,
      f.ruleId,
      f.caseId,
      f.elementId,
      f.property,
      String(f.expected),
      f.actual === null ? "-" : String(f.actual),
      f.error === null ? "-" : String(f.error),
      String(f.tolerance),
      f.severity,
      f.status,
    ]),
  };
}

export function fidelityMarkdown(report: FidelityReport, compositePath?: string): string {
  const lines = [
    `## Fidelity ${report.feature}: ${report.status}`,
    "",
    `Coverage: ${report.coverage.executed} of ${report.coverage.required} required cases measured${report.coverage.pending > 0 ? `; pending: ${report.coverage.pendingCases.join(", ")}` : ""}.`,
    `Visual: ${report.visualStatus}. Accessibility: ${report.accessibilityStatus} (use ${code("fs_a11y_run")}).`,
  ];
  if (report.environment)
    lines.push(
      `Environment: ${report.environment.browser} ${report.environment.browserVersion} on ${report.environment.os}, DPR ${report.environment.dpr}.`,
    );
  if (report.blockers.length > 0)
    lines.push("", "Blocked by:", ...report.blockers.map((b) => `- ${b}`));
  if (report.failures.length > 0)
    lines.push(
      "",
      table(
        [
          "id",
          "rule",
          "case",
          "element.property",
          "expected",
          "actual",
          "error",
          "severity",
          "status",
        ],
        report.failures
          .slice(0, 40)
          .map((f) => [
            f.id,
            f.ruleId,
            f.caseId,
            `${f.elementId}.${f.property}`,
            String(f.expected),
            f.actual === null ? "-" : String(f.actual),
            f.error === null ? "-" : String(f.error),
            f.severity,
            f.status,
          ]),
      ),
    );
  if (report.regions.length > 0)
    lines.push(
      "",
      table(
        ["case", "region", "d_R", "q_k", "k", "largest component", "status"],
        report.regions.map((r) => [
          r.caseId,
          r.regionId,
          r.dR.toFixed(6),
          r.qK.toFixed(6),
          String(r.k),
          String(r.largestComponent),
          r.status,
        ]),
      ),
    );
  if (compositePath)
    lines.push("", `Evidence image: ${code(compositePath)} (reference, actual, diff).`);
  lines.push("", `Report: ${code(`${report.evidence.dir}/fidelity-report.json`)}`);
  return capOutput(lines.join("\n"), `Full report: ${report.evidence.dir}/fidelity-report.json`);
}

export function a11yBlock(report: A11yReport): UiBlock {
  const byCase = new Map<string, TestCaseResult[]>();
  for (const f of report.findings) {
    const list = byCase.get(f.caseId) ?? [];
    list.push({
      name: `${f.ruleId}${f.elementId ? ` ${f.elementId}` : ""}`,
      status: status(f.status),
      error: f.message,
    });
    byCase.set(f.caseId, list);
  }
  const suites = [...byCase].map(([name, cases]) => ({ name, cases }));
  if (suites.length === 0)
    suites.push({ name: "a11y", cases: [{ name: "no finding", status: status(report.status) }] });
  return { kind: "test-results", framework: "frontsmith", suites };
}

export function a11yMarkdown(report: A11yReport): string {
  const lines = [`## Runtime accessibility: ${report.status}`, "", report.disclaimer];
  if (report.findings.length > 0)
    lines.push(
      "",
      table(
        ["rule", "case", "element", "severity", "status", "message"],
        report.findings
          .slice(0, 50)
          .map((f) => [f.ruleId, f.caseId, f.elementId ?? "-", f.severity, f.status, f.message]),
      ),
    );
  if (report.coverage.length > 0)
    lines.push(
      "",
      table(
        ["case", "axe", "keyboard", "contrast"],
        report.coverage.map((c) => [c.caseId, c.axe, c.keyboard, c.contrast]),
      ),
    );
  return capOutput(lines.join("\n"), "Full report: a11y-report.json in the run directory.");
}

export function calibrationMarkdown(
  file: CalibrationFile,
  quality: Record<string, ValidatorQuality>,
  unseparable: readonly string[],
  written: boolean,
  confirmCommand: string,
): string {
  const rows = Object.entries(file.cases).flatMap(([caseId, c]) =>
    Object.entries(c.regions).map(([regionId, r]) => [
      caseId,
      regionId,
      r.u_d.toFixed(6),
      r.v_d === null ? "-" : r.v_d.toFixed(6),
      r.limit_d === null ? "-" : r.limit_d.toFixed(6),
      r.status,
    ]),
  );
  const q = Object.entries(quality).map(([caseId, v]) => [
    caseId,
    v.sensitivity === null ? "-" : v.sensitivity.toFixed(3),
    v.falsePositiveRate === null ? "-" : v.falsePositiveRate.toFixed(3),
    `${v.tp}/${v.fn}/${v.fp}/${v.tn}`,
  ]);
  return [
    `## Calibration ${file.id}: ${written ? "written" : "not written yet"}`,
    "",
    `Browser: ${file.browser} ${file.browserVersion}.`,
    "",
    table(["case", "region", "noise u (d)", "defect v (d)", "limit (d)", "status"], rows),
    "",
    "Validator quality over the labelled set:",
    "",
    table(["case", "sensitivity", "false positive rate", "TP/FN/FP/TN"], q),
    ...(unseparable.length > 0
      ? [
          "",
          `Unseparable (their visual checks stay REVIEW until the environment is stabilised): ${unseparable.join(", ")}.`,
        ]
      : []),
    ...(written
      ? []
      : ["", `Nothing was written. To keep this calibration run ${code(confirmCommand)}.`]),
  ].join("\n");
}

export function baselinesMarkdown(feature: string, files: BaselineMeta["files"]): string {
  const rows = Object.entries(files).map(([caseId, f]) => [
    caseId,
    f.sha256.slice(0, 12),
    `${f.browser} ${f.browserVersion}`,
    f.os,
    f.approvedAt.slice(0, 10),
  ]);
  return rows.length === 0
    ? `No approved baselines for ${code(feature)}. Review a run, then ${code(`/frontsmith:baseline approve ${feature}`)}.`
    : [
        `## Baselines of ${feature}`,
        "",
        table(["case", "sha256", "browser", "os", "approved"], rows),
      ].join("\n");
}
