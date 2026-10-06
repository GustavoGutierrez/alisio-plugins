import type { UiContractEnvelope } from "../envelopes/ui-contract.js";
import { aggregate, type Verdict } from "../verdict.js";
import type { CalibrationFile } from "./calibration.js";
import { type Summary, summarize } from "./geometry.js";
import type { CaseMeasure, ElementMeasure, Environment, MeasureDoc } from "./measure.js";
import type { RegionMetrics } from "./regions.js";
import { type RelationProperty, relationValue } from "./relations.js";
import { canonicalColor, familyValue, normalizeText, pxValue, weightValue } from "./typography.js";

/** The slice of the approved contract the evaluator reads (spec 11.3, B-15 code-owned keys included). */
export interface FidelityContract {
  fidelityRules: UiContractEnvelope["fidelityRules"];
  regions: UiContractEnvelope["regions"];
  cases: UiContractEnvelope["cases"];
  /** `BLOCKED` by default (FID 16.11): a colour over an unknown background cannot be judged. */
  unknownBackground?: "BLOCKED" | "REVIEW";
}

/** What the application computed from the capture and the approved baseline of one case. */
export interface CaseVisual {
  /** No approved baseline exists for the case: the visual rules are BLOCKED. */
  baselineMissing?: boolean;
  sizes?: { actual: [number, number]; baseline: [number, number] };
  regions: Record<string, RegionMetrics>;
}

export interface EvaluateInput {
  feature: string;
  runId: string;
  contract: FidelityContract;
  /** Cases that must be evidenced; a missing one is pending and the report is BLOCKED (FID 15.10). */
  requiredCases: readonly string[];
  measure: MeasureDoc | undefined;
  visual?: Record<string, CaseVisual | undefined>;
  calibration?: CalibrationFile | undefined;
  /** Stage 0: oracles missing or changed, probe unavailable. Any problem BLOCKS the run. */
  integrity?: readonly string[];
  environment?: Environment;
  evidenceDir: string;
  composite?: string;
}

export interface FidelityFailure {
  id: string;
  ruleId: string;
  caseId: string;
  elementId: string;
  property: string;
  unit: string | null;
  expected: string | number | boolean;
  actual: string | number | boolean | null;
  error: number | null;
  tolerance: number;
  severity: "blocker" | "major" | "minor";
  status: Verdict;
  note?: string;
}

export interface FidelityRegionResult {
  caseId: string;
  regionId: string;
  dR: number;
  qK: number;
  k: number;
  largestComponent: number;
  status: Verdict | "UNSEPARABLE";
}

export interface FidelityReport {
  schema: "frontsmith.fidelity-report/v1";
  feature: string;
  runId: string;
  status: Verdict;
  environment: Environment | null;
  coverage: { required: number; executed: number; pending: number; pendingCases: string[] };
  failures: FidelityFailure[];
  regions: FidelityRegionResult[];
  summary: { geometry: Summary; relation: Summary; typography: Summary };
  visualStatus: Verdict | "NOT_RUN";
  accessibilityStatus: "NOT_RUN";
  evidence: { dir: string; composite?: string };
  /** Reasons the run is BLOCKED (integrity problems, missing baselines, missing cases). */
  blockers: string[];
}

interface RuleOutcome {
  status: Verdict;
  actual: string | number | boolean | null;
  error: number | null;
  note?: string;
}

const severityOf = (severity: "blocking" | "major" | "minor"): FidelityFailure["severity"] =>
  severity === "blocking" ? "blocker" : severity;

const numeric = (rule: { expected: string | number | boolean }): number | undefined =>
  typeof rule.expected === "number" ? rule.expected : pxValue(String(rule.expected));

const blocked = (note: string): RuleOutcome => ({
  status: "BLOCKED",
  actual: null,
  error: null,
  note,
});

function compare(actual: number, expected: number, tolerance: number): RuleOutcome {
  const error = Math.abs(actual - expected);
  return { status: error <= tolerance ? "PASS" : "FAIL", actual, error };
}

function geometry(
  rule: FidelityContract["fidelityRules"][number],
  element: ElementMeasure,
): RuleOutcome {
  const expected = numeric(rule);
  if (expected === undefined) return blocked("expected must be a number of CSS pixels");
  const box = element.box;
  const actual =
    rule.property === "x"
      ? box.x
      : rule.property === "y"
        ? box.y
        : rule.property === "width"
          ? box.width
          : box.height;
  return compare(actual, expected, rule.tolerance);
}

function relation(
  rule: FidelityContract["fidelityRules"][number],
  subject: ElementMeasure,
  object: ElementMeasure | null | undefined,
): RuleOutcome {
  const expected = numeric(rule);
  if (expected === undefined) return blocked("expected must be a number");
  if (rule.property === "columns") {
    if (subject.columns === undefined) return blocked("the probe did not measure the columns");
    return compare(subject.columns, expected, rule.tolerance);
  }
  if (rule.object === undefined) return blocked("a relation needs an object element");
  if (!object)
    return {
      status: "FAIL",
      actual: null,
      error: null,
      note: `element ${rule.object} was not found`,
    };
  return compare(
    relationValue(rule.property as RelationProperty, subject.box, object.box),
    expected,
    rule.tolerance,
  );
}

function typography(
  rule: FidelityContract["fidelityRules"][number],
  element: ElementMeasure,
): RuleOutcome {
  const style = (name: string): string | undefined => element.styles[name];
  if (rule.property === "lineCount") {
    const expected = numeric(rule);
    if (expected === undefined || element.lineCount === undefined)
      return blocked("the line count was not measured");
    const outcome = compare(element.lineCount, expected, rule.tolerance);
    // The count is an approximation of the client rectangles (S-R12): a mismatch is a review item.
    return outcome.status === "FAIL"
      ? { ...outcome, status: "REVIEW", note: "line counts are approximate" }
      : outcome;
  }
  if (rule.property === "fontFamily") {
    const actual = style("font-family");
    if (actual === undefined) return blocked("font-family was not measured");
    const same = familyValue(actual) === familyValue(String(rule.expected));
    return { status: same ? "PASS" : "FAIL", actual: familyValue(actual), error: same ? 0 : 1 };
  }
  if (rule.property === "fontWeight") {
    const actual = weightValue(style("font-weight") ?? "");
    const expected = weightValue(rule.expected as string | number);
    if (actual === undefined || expected === undefined)
      return blocked("font-weight is not numeric");
    return compare(actual, expected, rule.tolerance);
  }
  const property =
    rule.property === "fontSize"
      ? "font-size"
      : rule.property === "lineHeight"
        ? "line-height"
        : "letter-spacing";
  const raw = style(property);
  if (raw === undefined) return blocked(`${property} was not measured`);
  const actual = rule.property === "letterSpacing" && raw === "normal" ? 0 : pxValue(raw);
  const expected = numeric(rule);
  if (expected === undefined) return blocked("expected must be a number of CSS pixels");
  if (actual === undefined)
    return {
      status: "REVIEW",
      actual: raw,
      error: null,
      note: `${property} is ${raw}, which is not in pixels`,
    };
  return compare(actual, expected, rule.tolerance);
}

function color(
  rule: FidelityContract["fidelityRules"][number],
  element: ElementMeasure,
  policy: "BLOCKED" | "REVIEW",
): RuleOutcome {
  const expected = canonicalColor(String(rule.expected));
  if (expected === undefined)
    return {
      status: "REVIEW",
      actual: null,
      error: null,
      note: "unsupported colour format in the contract",
    };
  let raw: string | undefined;
  if (rule.property === "backgroundColor") {
    if (element.background === "unknown")
      return {
        status: policy === "REVIEW" ? "REVIEW" : "BLOCKED",
        actual: null,
        error: null,
        note: "the background behind the element cannot be resolved (image, filter or blend)",
      };
    raw = element.background;
  } else raw = element.styles[rule.property === "color" ? "color" : "border-color"];
  const actual = raw === undefined ? undefined : canonicalColor(raw);
  if (actual === undefined)
    return {
      status: "REVIEW",
      actual: raw ?? null,
      error: null,
      note: "unsupported colour format measured",
    };
  return {
    status: actual === expected ? "PASS" : "FAIL",
    actual,
    error: actual === expected ? 0 : 1,
  };
}

function content(
  rule: FidelityContract["fidelityRules"][number],
  element: ElementMeasure | null,
): RuleOutcome {
  if (rule.property === "absence") {
    const absent = element === null || !element.visible;
    return {
      status: absent ? "PASS" : "FAIL",
      actual: absent ? "absent" : "present",
      error: absent ? 0 : 1,
    };
  }
  if (element === null || !element.visible)
    return { status: "FAIL", actual: "absent", error: 1, note: "the element is not present" };
  if (rule.property === "presence") return { status: "PASS", actual: "present", error: 0 };
  const actual = normalizeText(element.text ?? "");
  const same = actual === normalizeText(String(rule.expected));
  return { status: same ? "PASS" : "FAIL", actual, error: same ? 0 : 1 };
}

function asset(
  rule: FidelityContract["fidelityRules"][number],
  element: ElementMeasure,
): RuleOutcome {
  if (rule.property === "sha256") {
    if (!element.assetSha256) return blocked("the asset hash was not measured");
    const same = element.assetSha256.toLowerCase() === String(rule.expected).toLowerCase();
    return { status: same ? "PASS" : "FAIL", actual: element.assetSha256, error: same ? 0 : 1 };
  }
  if (!element.naturalSize) return blocked("the natural size was not measured");
  const actual = `${element.naturalSize[0]}x${element.naturalSize[1]}`;
  return {
    status: actual === String(rule.expected) ? "PASS" : "FAIL",
    actual,
    error: actual === String(rule.expected) ? 0 : 1,
  };
}

function visualOutcome(
  rule: FidelityContract["fidelityRules"][number],
  contract: FidelityContract,
  caseId: string,
  visual: CaseVisual | undefined,
  calibration: CalibrationFile | undefined,
  regions: FidelityRegionResult[],
): RuleOutcome {
  const region = contract.regions.find(
    (r) => r.id === rule.subject || r.elementId === rule.subject,
  );
  if (!region) return blocked(`no region is declared for ${rule.subject}`);
  if (!visual || visual.baselineMissing)
    return blocked("no approved baseline exists for this case (/frontsmith:baseline approve)");
  if (
    visual.sizes &&
    (visual.sizes.actual[0] !== visual.sizes.baseline[0] ||
      visual.sizes.actual[1] !== visual.sizes.baseline[1])
  )
    return {
      status: "FAIL",
      actual: `${visual.sizes.actual[0]}x${visual.sizes.actual[1]}`,
      error: 1,
      note: `VIS-DIM: the capture is ${visual.sizes.actual[0]}x${visual.sizes.actual[1]} but the baseline is ${visual.sizes.baseline[0]}x${visual.sizes.baseline[1]}`,
    };
  const metrics = visual.regions[region.id];
  if (!metrics) return blocked(`the region ${region.id} was not compared`);
  const calibrated = calibration?.cases[caseId]?.regions[region.id];
  let status: Verdict | "UNSEPARABLE";
  let note: string | undefined;
  if (
    !calibrated ||
    calibrated.limit_d === null ||
    calibrated.limit_q === null ||
    calibrated.v_d === null ||
    calibrated.v_q === null
  ) {
    status = calibrated?.status === "UNSEPARABLE" ? "UNSEPARABLE" : "REVIEW";
    note = calibrated
      ? "the region is unseparable: noise is as large as the smallest defect"
      : "visual acceptance needs a calibration (/frontsmith:fidelity calibrate)";
  } else if (metrics.dR >= calibrated.v_d || metrics.qK >= calibrated.v_q) status = "FAIL";
  else if (metrics.dR <= calibrated.limit_d && metrics.qK <= calibrated.limit_q) status = "PASS";
  else status = "REVIEW";
  regions.push({
    caseId,
    regionId: region.id,
    dR: metrics.dR,
    qK: metrics.qK,
    k: metrics.k,
    largestComponent: metrics.largestComponent,
    status,
  });
  const verdict: Verdict = status === "UNSEPARABLE" ? "REVIEW" : status;
  return { status: verdict, actual: metrics.dR, error: metrics.dR, ...(note ? { note } : {}) };
}

/**
 * The fidelity evaluator (spec 11.3, FID 15.9, 15.10): stage 0 integrity, stage 1 measurement,
 * stage 2 visual regions, stage 3 integration. No average and no score: the status is the
 * precedence aggregation of the evidence; a missing required case is BLOCKED, never PASS.
 */
export function evaluateFidelity(input: EvaluateInput): FidelityReport {
  const { contract } = input;
  const blockers: string[] = [...(input.integrity ?? [])];
  const failures: FidelityFailure[] = [];
  const regions: FidelityRegionResult[] = [];
  const checks: Array<{ status: Verdict; required: boolean }> = [];
  const policy = contract.unknownBackground ?? "BLOCKED";
  const errorsOf: Record<"geometry" | "relation" | "typography", number[]> = {
    geometry: [],
    relation: [],
    typography: [],
  };
  const executed: string[] = [];
  const pendingCases: string[] = [];

  for (const caseId of input.requiredCases) {
    const measured: CaseMeasure | undefined = input.measure?.cases[caseId];
    // Stage 0: with a missing or changed oracle nothing is evaluated (FID 15.9).
    if (!measured || (input.integrity?.length ?? 0) > 0) {
      pendingCases.push(caseId);
      continue;
    }
    executed.push(caseId);
    // Stage 3: integration problems of the page.
    const allowsOverflow = contract.fidelityRules.some(
      (r) => r.kind === "overflow" && r.property === "pageHorizontal" && r.expected === true,
    );
    if (measured.pageOverflow && !allowsOverflow)
      failures.push({
        id: "",
        ruleId: "OVF-PAGE",
        caseId,
        elementId: "page",
        property: "pageHorizontal",
        unit: null,
        expected: false,
        actual: true,
        error: 1,
        tolerance: 0,
        severity: "blocker",
        status: "FAIL",
      });
    for (const [elementId, element] of Object.entries(measured.elements))
      if (element?.covered)
        failures.push({
          id: "",
          ruleId: "INT-OVERLAP",
          caseId,
          elementId,
          property: "covered",
          unit: null,
          expected: false,
          actual: true,
          error: 1,
          tolerance: 0,
          severity: "blocker",
          status: "FAIL",
        });
    if (measured.pageOverflow && !allowsOverflow) checks.push({ status: "FAIL", required: true });
    if (Object.values(measured.elements).some((e) => e?.covered))
      checks.push({ status: "FAIL", required: true });

    for (const rule of contract.fidelityRules) {
      if (rule.kind === "focus") continue; // keyboard and focus belong to the accessibility run
      const subject = measured.elements[rule.subject];
      let outcome: RuleOutcome;
      if (rule.kind === "visual")
        outcome = visualOutcome(
          rule,
          contract,
          caseId,
          input.visual?.[caseId],
          input.calibration,
          regions,
        );
      else if (rule.kind === "overflow")
        outcome =
          rule.property === "pageHorizontal"
            ? {
                status: measured.pageOverflow === (rule.expected === true) ? "PASS" : "FAIL",
                actual: measured.pageOverflow,
                error: measured.pageOverflow === (rule.expected === true) ? 0 : 1,
              }
            : subject
              ? {
                  status: subject.clipped === (rule.expected === true) ? "PASS" : "FAIL",
                  actual: subject.clipped,
                  error: subject.clipped === (rule.expected === true) ? 0 : 1,
                }
              : {
                  status: "FAIL",
                  actual: null,
                  error: null,
                  note: `element ${rule.subject} was not found`,
                };
      else if (rule.kind === "content") outcome = content(rule, subject ?? null);
      else if (!subject)
        outcome = {
          status: "FAIL",
          actual: null,
          error: null,
          note: `element ${rule.subject} was not found`,
        };
      else if (rule.kind === "geometry") outcome = geometry(rule, subject);
      else if (rule.kind === "relation")
        outcome = relation(rule, subject, rule.object ? measured.elements[rule.object] : undefined);
      else if (rule.kind === "typography") outcome = typography(rule, subject);
      else if (rule.kind === "color") outcome = color(rule, subject, policy);
      else outcome = asset(rule, subject);
      checks.push({ status: outcome.status, required: true });
      if (
        outcome.error !== null &&
        outcome.status !== "BLOCKED" &&
        (rule.kind === "geometry" ||
          rule.kind === "relation" ||
          (rule.kind === "typography" &&
            rule.property !== "fontFamily" &&
            rule.property !== "lineCount"))
      )
        errorsOf[rule.kind].push(outcome.error);
      if (outcome.status !== "PASS")
        failures.push({
          id: "",
          ruleId: rule.id,
          caseId,
          elementId: rule.subject,
          property: rule.property,
          unit: rule.unit ?? null,
          expected: rule.expected,
          actual: outcome.actual,
          error: outcome.error,
          tolerance: rule.tolerance,
          severity: severityOf(rule.severity),
          status: outcome.status,
          ...(outcome.note ? { note: outcome.note } : {}),
        });
    }
  }

  failures
    .sort(
      (a, b) =>
        a.caseId.localeCompare(b.caseId) ||
        a.ruleId.localeCompare(b.ruleId) ||
        a.elementId.localeCompare(b.elementId),
    )
    .forEach((failure, index) => {
      failure.id = `F-${String(index + 1).padStart(4, "0")}`;
    });
  if (pendingCases.length > 0)
    blockers.push(
      `${pendingCases.length} required case${pendingCases.length === 1 ? "" : "s"} not measured: ${pendingCases.join(", ")}`,
    );
  for (const failure of failures)
    if (failure.status === "BLOCKED" && failure.note)
      blockers.push(`${failure.ruleId} (${failure.caseId}): ${failure.note}`);

  const evidenced: Array<{ status: Verdict; required: boolean }> = [...checks];
  if (pendingCases.length > 0) evidenced.push({ status: "BLOCKED", required: true });
  const { verdict } =
    evidenced.length === 0 ? { verdict: "BLOCKED" as Verdict } : aggregate(evidenced);
  const visualStatuses = regions.map((r) => (r.status === "UNSEPARABLE" ? "REVIEW" : r.status));
  const visualStatus: FidelityReport["visualStatus"] = !contract.fidelityRules.some(
    (r) => r.kind === "visual",
  )
    ? "NOT_RUN"
    : visualStatuses.length === 0
      ? "BLOCKED"
      : visualStatuses.includes("FAIL")
        ? "FAIL"
        : visualStatuses.includes("REVIEW")
          ? "REVIEW"
          : "PASS";
  return {
    schema: "frontsmith.fidelity-report/v1",
    feature: input.feature,
    runId: input.runId,
    status: verdict,
    environment: input.environment ?? input.measure?.environment ?? null,
    coverage: {
      required: input.requiredCases.length,
      executed: executed.length,
      pending: pendingCases.length,
      pendingCases,
    },
    failures,
    regions,
    summary: {
      geometry: summarize(errorsOf.geometry),
      relation: summarize(errorsOf.relation),
      typography: summarize(errorsOf.typography),
    },
    visualStatus,
    accessibilityStatus: "NOT_RUN",
    evidence: {
      dir: input.evidenceDir,
      ...(input.composite ? { composite: input.composite } : {}),
    },
    blockers,
  };
}
