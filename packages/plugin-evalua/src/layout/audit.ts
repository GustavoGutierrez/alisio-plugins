import type { CheckFinding } from "../knowledge/report.js";
import { legibilityFloors } from "./presets.js";

/** The in-page audit (spec 11.4): run per preset, deterministic, no browser needed to parse. */

export interface AuditReport {
  /** Elements whose scrollWidth exceeds their box (horizontal overflow). */
  overflow: string[];
  /** Sibling item boxes that intersect. */
  overlap: string[];
  /** Leaf text nodes whose computed size is below the floor. */
  minSize: string[];
  /** Display formulas wider than their column. */
  mathScaled: string[];
  /** Answer areas below their floor. */
  answerSpace: string[];
}

/** The JavaScript the browser evaluates; it returns the `AuditReport` as a plain object. */
export function auditScript(floors = legibilityFloors): string {
  return `(() => {
  try {
    const floors = ${JSON.stringify(floors)};
    const floorPx = (floors.bodyPt * 4) / 3;
    const label = (el) => {
      const cls = typeof el.className === "string" ? el.className : "";
      return cls ? cls.split(" ")[0] : el.tagName.toLowerCase();
    };
    const overflow = [];
    const minSize = [];
    const mathScaled = [];
    const answerSpace = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".katex") || el.classList.contains("ref")) continue;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) overflow.push(label(el));
      if (el.children.length === 0 && (el.textContent || "").trim() !== "") {
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (Number.isFinite(size) && size + 0.5 < floorPx) minSize.push(label(el));
      }
    }
    for (const area of document.querySelectorAll(".answer-space")) {
      const lines = parseFloat(getComputedStyle(area).getPropertyValue("--answer-lines"));
      if (Number.isFinite(lines) && lines > 0) {
        const height = area.getBoundingClientRect().height;
        if (height + 0.5 < lines * floors.bodyPt * 2) answerSpace.push(label(area));
      }
    }
    for (const display of document.querySelectorAll(".katex-display")) {
      const box = display.getBoundingClientRect();
      const parent = display.parentElement ? display.parentElement.getBoundingClientRect() : box;
      if (box.width > parent.width + 1) mathScaled.push(label(display));
    }
    const boxes = [...document.querySelectorAll(".item")].map((el) => el.getBoundingClientRect());
    const overlap = [];
    for (let i = 1; i < boxes.length; i += 1) {
      const a = boxes[i - 1];
      const b = boxes[i];
      if (b.top < a.bottom - 0.5 && b.left < a.right - 0.5 && b.right > a.left + 0.5) {
        overlap.push("item " + (i + 1));
      }
    }
    return { overflow, overlap, minSize, mathScaled, answerSpace };
  } catch (error) {
    return { overflow: [], overlap: [], minSize: [], mathScaled: [], answerSpace: [], error: String(error) };
  }
})()`;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Validates the browser report; returns undefined when it is not an audit report. */
export function parseAuditReport(value: unknown): AuditReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const keys: (keyof AuditReport)[] = [
    "overflow",
    "overlap",
    "minSize",
    "mathScaled",
    "answerSpace",
  ];
  const report = {} as AuditReport;
  for (const key of keys) {
    if (!isStringArray(record[key])) return undefined;
    report[key] = record[key];
  }
  return report;
}

/** Maps an audit report to the deterministic findings (EVL-LAY-002 error, EVL-LAY-004 warning). */
export function auditFindings(report: AuditReport): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const problems: Array<[keyof AuditReport, string]> = [
    ["overflow", "horizontal overflow"],
    ["overlap", "overlapping boxes"],
    ["minSize", "text below the legibility floor"],
    ["answerSpace", "answer space below the floor"],
  ];
  for (const [key, message] of problems) {
    const items = report[key];
    if (items.length > 0) {
      findings.push({
        id: "EVL-LAY-002",
        severity: "error",
        subject: "layout",
        message: `${message}: ${items.slice(0, 5).join(", ")}`,
      });
    }
  }
  if (report.mathScaled.length > 0) {
    findings.push({
      id: "EVL-LAY-004",
      severity: "warning",
      subject: "layout",
      message: `display formula wider than its column: ${report.mathScaled.slice(0, 5).join(", ")}`,
    });
  }
  return findings;
}
