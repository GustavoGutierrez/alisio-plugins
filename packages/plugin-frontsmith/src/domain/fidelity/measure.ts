import type { Box } from "./geometry.js";

export interface Environment {
  browser: string;
  browserVersion: string;
  playwrightVersion: string;
  os: string;
  dpr: number;
}

/** One element as the probe measured it, in CSS pixels (spec 11.2). */
export interface ElementMeasure {
  box: Box;
  /** Resolved (computed) values of the style properties named in the request. */
  styles: Record<string, string>;
  text?: string;
  /** Approximate: client rectangles grouped by line (S-R12). */
  lineCount?: number;
  /** Content is clipped on the node or on an ancestor with overflow hidden. */
  clipped: boolean;
  visible: boolean;
  /** `#RRGGBB(AA)` of the first opaque background up the ancestors, or `unknown` (filters, images, blends). */
  background: string;
  /** Another element sits on top of its centre point. */
  covered: boolean;
  columns?: number;
  assetSha256?: string;
  naturalSize?: [number, number];
}

export interface FocusStep {
  /** The element id matched by locator, or `null` when the focused node is not a contract element. */
  elementId: string | null;
  visible: boolean;
  obscured: boolean;
  /** The computed outline or box shadow differs from the unfocused state. */
  indicator: boolean;
}

export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  nodes: number;
}

export interface CaseMeasure {
  caseId: string;
  viewport: [number, number];
  /** PNG file name inside the run directory. */
  capture: string;
  /** Capture size in device pixels. */
  captureSize: [number, number];
  pageOverflow: boolean;
  elements: Record<string, ElementMeasure | null>;
  fonts: Array<{ family: string; status: string }>;
  /** Boxes hidden by masks, in CSS pixels. */
  masks: Box[];
  /** Calibration only: file names of the unchanged repetitions and of each mutation capture. */
  repetitions?: string[];
  mutations?: Record<string, string>;
  focus?: FocusStep[];
  axe?: { violations: AxeViolation[] } | { blocked: string };
}

export interface MeasureDoc {
  schemaVersion: 1;
  environment: Environment;
  cases: Record<string, CaseMeasure>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isBox = (value: unknown): value is Box =>
  isRecord(value) &&
  ["x", "y", "width", "height"].every(
    (k) => typeof value[k] === "number" && Number.isFinite(value[k]),
  );

export type MeasureParse = { ok: true; doc: MeasureDoc } | { ok: false; errors: string[] };

/** Shape check of a probe's `measure.json`: the evaluator never trusts an unchecked file. */
export function parseMeasure(raw: unknown): MeasureParse {
  const errors: string[] = [];
  if (!isRecord(raw) || raw.schemaVersion !== 1)
    return { ok: false, errors: ["measure.json needs schemaVersion 1"] };
  if (
    !isRecord(raw.environment) ||
    typeof raw.environment.browser !== "string" ||
    typeof raw.environment.browserVersion !== "string"
  )
    errors.push("environment must name the browser and its version");
  if (!isRecord(raw.cases)) errors.push("cases must be an object");
  else
    for (const [id, c] of Object.entries(raw.cases)) {
      if (!isRecord(c)) {
        errors.push(`cases/${id} must be an object`);
        continue;
      }
      if (typeof c.capture !== "string" || c.capture.includes("/") || c.capture.includes(".."))
        errors.push(`cases/${id}/capture must be a file name`);
      if (typeof c.pageOverflow !== "boolean")
        errors.push(`cases/${id}/pageOverflow must be a boolean`);
      if (!isRecord(c.elements)) errors.push(`cases/${id}/elements must be an object`);
      else
        for (const [elementId, e] of Object.entries(c.elements))
          if (
            e !== null &&
            !(isRecord(e) && isBox(e.box) && isRecord(e.styles) && typeof e.background === "string")
          )
            errors.push(`cases/${id}/elements/${elementId} is malformed`);
      if (!Array.isArray(c.masks) || !c.masks.every(isBox))
        errors.push(`cases/${id}/masks must be boxes`);
    }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, doc: raw as unknown as MeasureDoc };
}
