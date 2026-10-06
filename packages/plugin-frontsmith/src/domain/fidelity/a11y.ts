import { classifyText, evaluateContrast } from "../color/contrast.js";
import type { Severity } from "../severity.js";
import { aggregate, type Verdict } from "../verdict.js";
import type { CaseMeasure } from "./measure.js";
import { canonicalColor, pxValue, weightValue } from "./typography.js";

export const A11Y_DISCLAIMER = "Automated checks do not establish WCAG conformance.";

export interface A11yFinding {
  ruleId: string;
  caseId: string;
  elementId: string | null;
  severity: Severity;
  status: Verdict;
  message: string;
}

export interface A11yReport {
  schema: "frontsmith.a11y-report/v1";
  status: Verdict;
  findings: A11yFinding[];
  /** Per case: which runtime evidence exists. */
  coverage: Array<{
    caseId: string;
    axe: "ran" | "blocked";
    keyboard: "ran" | "not-requested";
    contrast: "ran";
  }>;
  disclaimer: string;
}

/** axe impact to finding severity (spec 11.6): critical and serious are major, moderate minor, minor nit. */
export const impactSeverity = (impact: string | null): Severity =>
  impact === "critical" || impact === "serious" ? "major" : impact === "moderate" ? "minor" : "nit";

const statusOfSeverity = (severity: Severity): Verdict =>
  severity === "blocker" || severity === "major"
    ? "FAIL"
    : severity === "minor"
      ? "REVIEW"
      : "PASS";

export interface A11yInput {
  cases: readonly CaseMeasure[];
  /** The contract's focus order: element ids in the order Tab should reach them. */
  focusOrder: readonly string[];
  target: "AA" | "AAA";
  /** Product margins from `accessibility.operationalMargin` (reported, never WCAG thresholds). */
  margin: { text: number; nonText: number };
  axeRequested: boolean;
}

/**
 * Runtime accessibility (spec 11.6): axe violations as `FS-AXE-<rule>`, the keyboard probe as
 * `FOC-ORDER`, `FOC-VISIBLE` and `FOC-OBSCURED`, and the contrast of the colours the browser really
 * painted. An axe run that could not happen is BLOCKED with its reason, never PASS.
 */
export function evaluateA11y(input: A11yInput): A11yReport {
  const findings: A11yFinding[] = [];
  const coverage: A11yReport["coverage"] = [];
  const checks: Array<{ status: Verdict; required: boolean }> = [];
  for (const c of input.cases) {
    const add = (finding: A11yFinding): void => {
      findings.push(finding);
      checks.push({ status: finding.status, required: true });
    };
    // axe
    if (input.axeRequested) {
      if (!c.axe || "blocked" in c.axe) {
        const reason = c.axe && "blocked" in c.axe ? c.axe.blocked : "axe-not-run";
        add({
          ruleId: "FS-AXE-RUN",
          caseId: c.caseId,
          elementId: null,
          severity: "blocker",
          status: "BLOCKED",
          message: `The axe run was blocked: ${reason}.`,
        });
      } else {
        for (const v of c.axe.violations)
          add({
            ruleId: `FS-AXE-${v.id}`,
            caseId: c.caseId,
            elementId: null,
            severity: impactSeverity(v.impact),
            status: statusOfSeverity(impactSeverity(v.impact)),
            message: `${v.help} (${v.nodes} node${v.nodes === 1 ? "" : "s"}).`,
          });
        if (c.axe.violations.length === 0) checks.push({ status: "PASS", required: true });
      }
    }
    // keyboard
    if (c.focus && input.focusOrder.length > 0) {
      const reached = c.focus
        .map((step) => step.elementId)
        .filter((id): id is string => id !== null);
      const seenOrder: string[] = [];
      for (const id of reached) if (!seenOrder.includes(id)) seenOrder.push(id);
      for (const id of input.focusOrder)
        if (!seenOrder.includes(id))
          add({
            ruleId: "FOC-ORDER",
            caseId: c.caseId,
            elementId: id,
            severity: "major",
            status: "FAIL",
            message: `${id} is not reachable with the Tab key.`,
          });
      const reachedExpected = seenOrder.filter((id) => input.focusOrder.includes(id));
      const expected = input.focusOrder.filter((id) => seenOrder.includes(id));
      if (reachedExpected.join(">") !== expected.join(">"))
        add({
          ruleId: "FOC-ORDER",
          caseId: c.caseId,
          elementId: null,
          severity: "major",
          status: "FAIL",
          message: `Tab reaches ${reachedExpected.join(", ")} but the contract says ${expected.join(", ")}.`,
        });
      for (const step of c.focus) {
        if (step.elementId === null) continue;
        if (!step.visible || !step.indicator)
          add({
            ruleId: "FOC-VISIBLE",
            caseId: c.caseId,
            elementId: step.elementId,
            severity: "major",
            status: "FAIL",
            message: `${step.elementId} shows no visible focus indicator.`,
          });
        if (step.obscured)
          add({
            ruleId: "FOC-OBSCURED",
            caseId: c.caseId,
            elementId: step.elementId,
            severity: "major",
            status: "FAIL",
            message: `${step.elementId} is covered by another element when focused.`,
          });
      }
    }
    // real-pair contrast
    for (const [id, el] of Object.entries(c.elements)) {
      if (!el?.visible || !el.text) continue;
      const fg = canonicalColor(el.styles.color ?? "");
      if (!fg) continue;
      if (el.background === "unknown") {
        add({
          ruleId: "CTR-REAL",
          caseId: c.caseId,
          elementId: id,
          severity: "minor",
          status: "REVIEW",
          message: `The background behind ${id} cannot be resolved, so its contrast was not computed.`,
        });
        continue;
      }
      const kind = classifyText(
        pxValue(el.styles["font-size"] ?? ""),
        weightValue(el.styles["font-weight"] ?? ""),
      );
      const result = evaluateContrast({
        fg,
        bg: el.background,
        kind,
        target: input.target,
        margin: 0,
      });
      checks.push({ status: result.status, required: true });
      if (result.status !== "PASS")
        findings.push({
          ruleId: "CTR-REAL",
          caseId: c.caseId,
          elementId: id,
          severity: result.status === "FAIL" ? "major" : "minor",
          status: result.status,
          message: `${fg} on ${el.background} is ${result.ratio === null ? "unknown" : result.ratio.toFixed(6)} against a minimum of ${result.minimum} for ${kind.replace("_", " ")}.`,
        });
    }
    coverage.push({
      caseId: c.caseId,
      axe: c.axe && !("blocked" in c.axe) ? "ran" : "blocked",
      keyboard: c.focus ? "ran" : "not-requested",
      contrast: "ran",
    });
  }
  const { verdict } = checks.length === 0 ? { verdict: "BLOCKED" as Verdict } : aggregate(checks);
  return {
    schema: "frontsmith.a11y-report/v1",
    status: verdict,
    findings,
    coverage,
    disclaimer: A11Y_DISCLAIMER,
  };
}
