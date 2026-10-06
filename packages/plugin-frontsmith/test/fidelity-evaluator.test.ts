import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CalibrationFile } from "../src/domain/fidelity/calibration.js";
import {
  type CaseVisual,
  evaluateFidelity,
  type FidelityContract,
} from "../src/domain/fidelity/evaluate.js";
import { type MeasureDoc, parseMeasure } from "../src/domain/fidelity/measure.js";
import type { RegionMetrics } from "../src/domain/fidelity/regions.js";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fidelity", name), "utf8")) as T;
const contract = load<FidelityContract>("contract.json");
const measure = (name: string): MeasureDoc => load<MeasureDoc>(name);
const calibration = load<CalibrationFile>("calibration.json");
const CASES = ["projects-desktop-success", "projects-mobile-success"];

const metrics = (dR: number, qK: number): RegionMetrics => ({
  dR,
  qK,
  k: 16,
  largestComponent: 3,
  validPixels: 100,
  differingPixels: Math.round(dR * 100),
});
const visual = (m: RegionMetrics): Record<string, CaseVisual> =>
  Object.fromEntries(CASES.map((c) => [c, { regions: { cards: m } }]));

const run = (over: Partial<Parameters<typeof evaluateFidelity>[0]> = {}) =>
  evaluateFidelity({
    feature: "projects",
    runId: "r1",
    contract,
    requiredCases: CASES,
    measure: measure("measure-pass.json"),
    visual: visual(metrics(0.001, 0.05)),
    calibration,
    evidenceDir: ".alisio/frontsmith/evidence/projects/r1",
    ...over,
  });

describe("recorded measurements", () => {
  it("a measurement that matches every rule and a calibrated region passes with exact coverage", () => {
    const report = run();
    expect(report).toMatchObject({
      schema: "frontsmith.fidelity-report/v1",
      status: "PASS",
      coverage: { required: 2, executed: 2, pending: 0, pendingCases: [] },
      failures: [],
      visualStatus: "PASS",
      accessibilityStatus: "NOT_RUN",
      environment: { browser: "chromium", browserVersion: "153.0.0.0" },
    });
    expect(report.regions).toHaveLength(2);
    expect(JSON.stringify(report)).not.toMatch(/score|percent/i);
  });

  it("a geometry failure names the element, property, expected, actual, error, tolerance and severity", () => {
    const report = run({ measure: measure("measure-geometry-fail.json") });
    expect(report.status).toBe("FAIL");
    expect(report.failures).toEqual([
      expect.objectContaining({
        id: "F-0001",
        ruleId: "GEO-CTA",
        caseId: "projects-desktop-success",
        elementId: "primary-cta",
        property: "x",
        unit: "css_px",
        expected: 720,
        actual: 728,
        error: 8,
        tolerance: 0,
        severity: "blocker",
        status: "FAIL",
      }),
    ]);
    expect(report.summary.geometry).toMatchObject({ max: 8, count: 2 });
    expect(report.summary.geometry.median).toBe(4);
  });

  it("a relation failure compares the measured gap with the expected one", () => {
    const report = run({ measure: measure("measure-relation-fail.json") });
    expect(report.status).toBe("FAIL");
    expect(report.failures).toEqual([
      expect.objectContaining({
        ruleId: "REL-GAP",
        caseId: "projects-mobile-success",
        property: "gapVertical",
        expected: 32,
        actual: 40,
        error: 8,
      }),
    ]);
    expect(report.summary.relation.max).toBe(8);
  });

  it("a colour over an unknown background is BLOCKED by default and REVIEW when the contract says so", () => {
    const blocked = run({ measure: measure("measure-unknown-background.json") });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.failures).toEqual([
      expect.objectContaining({ ruleId: "COL-CTA", status: "BLOCKED" }),
    ]);
    expect(blocked.blockers.join(" ")).toContain("background");
    const review = run({
      measure: measure("measure-unknown-background.json"),
      contract: { ...contract, unknownBackground: "REVIEW" },
    });
    expect(review.status).toBe("REVIEW");
  });

  it("a required case that was not measured is pending and the report is BLOCKED, never PASS", () => {
    const report = run({ measure: measure("measure-missing-case.json") });
    expect(report.status).toBe("BLOCKED");
    expect(report.coverage).toEqual({
      required: 2,
      executed: 1,
      pending: 1,
      pendingCases: ["projects-mobile-success"],
    });
    expect(report.blockers.join(" ")).toContain("projects-mobile-success");
  });

  it("a known failure outranks pending cases: FAIL beats BLOCKED", () => {
    const geo = measure("measure-geometry-fail.json");
    delete geo.cases["projects-mobile-success"];
    expect(run({ measure: geo }).status).toBe("FAIL");
  });

  it("without a calibration the visual stage is REVIEW, never PASS", () => {
    const report = run({ calibration: undefined });
    expect(report.status).toBe("REVIEW");
    expect(report.visualStatus).toBe("REVIEW");
    expect(report.failures.every((f) => f.ruleId === "VIS-CARDS" && f.status === "REVIEW")).toBe(
      true,
    );
  });

  it("an UNSEPARABLE region stays REVIEW whatever the metrics are", () => {
    const report = run({
      calibration: load<CalibrationFile>("calibration-unseparable.json"),
      visual: visual(metrics(0, 0)),
    });
    expect(report.status).toBe("REVIEW");
    expect(report.regions.map((r) => r.status)).toEqual(["UNSEPARABLE", "UNSEPARABLE"]);
  });

  it("visual regions: within the limit PASS, between limit and defect bound REVIEW, at the defect bound FAIL", () => {
    expect(run({ visual: visual(metrics(0.005, 0.1)) }).visualStatus).toBe("PASS");
    expect(run({ visual: visual(metrics(0.006, 0.1)) }).visualStatus).toBe("REVIEW");
    expect(run({ visual: visual(metrics(0.0001, 0.12)) }).visualStatus).toBe("REVIEW");
    const failed = run({ visual: visual(metrics(0.01, 0.01)) });
    expect(failed.visualStatus).toBe("FAIL");
    expect(failed.status).toBe("FAIL");
    expect(run({ visual: visual(metrics(0.0001, 0.2)) }).status).toBe("FAIL");
  });

  it("a capture of another size than the baseline fails with VIS-DIM, and a missing baseline blocks", () => {
    const sized = Object.fromEntries(
      CASES.map((c) => [
        c,
        {
          sizes: { actual: [1024, 700], baseline: [1024, 640] },
          regions: { cards: metrics(0, 0) },
        },
      ]),
    ) as Record<string, CaseVisual>;
    const dim = run({ visual: sized });
    expect(dim.status).toBe("FAIL");
    expect(dim.failures[0]?.note).toContain("VIS-DIM");
    const none = Object.fromEntries(
      CASES.map((c) => [c, { baselineMissing: true, regions: {} }]),
    ) as Record<string, CaseVisual>;
    expect(run({ visual: none }).status).toBe("BLOCKED");
    expect(run({ visual: undefined }).status).toBe("BLOCKED");
  });

  it("an integrity problem blocks the whole run and evaluates nothing (stage 0)", () => {
    const report = run({ integrity: ["ui-contract.json changed after approval"] });
    expect(report.status).toBe("BLOCKED");
    expect(report.coverage.pending).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.blockers[0]).toContain("changed after approval");
  });

  it("page overflow and a covered element fail the integration stage", () => {
    const doc = measure("measure-pass.json");
    doc.cases["projects-desktop-success"]!.pageOverflow = true;
    doc.cases["projects-mobile-success"]!.elements.cards!.covered = true;
    const report = run({ measure: doc });
    expect(report.status).toBe("FAIL");
    expect(report.failures.map((f) => f.ruleId).sort()).toEqual([
      "INT-OVERLAP",
      "OVF-PAGE",
      "OVF-X",
    ]);
    doc.cases["projects-mobile-success"]!.pageOverflow = true;
    const allowed = run({
      measure: doc,
      contract: {
        ...contract,
        fidelityRules: [
          ...contract.fidelityRules.filter((r) => r.id !== "OVF-X"),
          { ...contract.fidelityRules.find((r) => r.id === "OVF-X")!, expected: true },
        ],
      },
    });
    expect(allowed.failures.map((f) => f.ruleId)).toEqual(["INT-OVERLAP"]);
  });

  it("typography is compared as numbers, a line count mismatch is only REVIEW, and unmeasurable values are REVIEW", () => {
    const doc = measure("measure-pass.json");
    doc.cases["projects-desktop-success"]!.elements["card-title"]!.styles["font-size"] = "20px";
    expect(run({ measure: doc }).failures).toEqual([
      expect.objectContaining({
        ruleId: "TYPE-TITLE",
        expected: "18px",
        actual: 20,
        error: 2,
        status: "FAIL",
      }),
    ]);
    const rules = [
      {
        ...contract.fidelityRules.find((r) => r.id === "TYPE-TITLE")!,
        id: "TYPE-LINES",
        property: "lineCount",
        expected: 2,
        severity: "minor" as const,
      },
    ];
    const lines = measure("measure-pass.json");
    for (const c of Object.values(lines.cases)) c.elements["card-title"]!.lineCount = 3;
    const outcome = run({
      measure: lines,
      contract: { ...contract, fidelityRules: rules, regions: [] },
    });
    expect(outcome.status).toBe("REVIEW");
    expect(outcome.failures[0]).toMatchObject({
      status: "REVIEW",
      note: "line counts are approximate",
      severity: "minor",
    });
    const normal = measure("measure-pass.json");
    for (const c of Object.values(normal.cases))
      c.elements["card-title"]!.styles["line-height"] = "normal";
    const lh = [
      {
        ...contract.fidelityRules.find((r) => r.id === "TYPE-TITLE")!,
        id: "TYPE-LH",
        property: "lineHeight",
        expected: "24px",
      },
    ];
    expect(
      run({ measure: normal, contract: { ...contract, fidelityRules: lh, regions: [] } }).status,
    ).toBe("REVIEW");
  });

  it("content, colour and asset rules compare canonical values", () => {
    const doc = measure("measure-pass.json");
    for (const c of Object.values(doc.cases)) {
      c.elements["primary-cta"]!.text = "Create the project";
      c.elements.logo!.assetSha256 = "ffff";
      c.elements["primary-cta"]!.background = "#2563EA";
    }
    const report = run({ measure: doc });
    expect(report.failures.map((f) => f.ruleId).sort()).toEqual([
      "AST-LOGO",
      "AST-LOGO",
      "CNT-CTA",
      "CNT-CTA",
      "COL-CTA",
      "COL-CTA",
    ]);
    const absent = run({
      measure: measure("measure-pass.json"),
      contract: {
        ...contract,
        fidelityRules: [
          {
            ...contract.fidelityRules.find((r) => r.id === "CNT-CTA")!,
            id: "CNT-NONE",
            subject: "ghost",
            property: "absence",
          },
        ],
        regions: [],
      },
    });
    expect(absent.status).toBe("PASS");
  });

  it("an element that cannot be found fails its rule", () => {
    const doc = measure("measure-pass.json");
    doc.cases["projects-desktop-success"]!.elements["primary-cta"] = null;
    const report = run({ measure: doc });
    expect(
      report.failures
        .filter((f) => f.caseId === "projects-desktop-success")
        .map((f) => f.ruleId)
        .sort(),
    ).toEqual(["COL-CTA", "CNT-CTA", "GEO-CTA"].sort());
  });

  it("assigns finding ids in stable order and never omits the environment", () => {
    const a = run({ measure: measure("measure-geometry-fail.json") });
    const b = run({ measure: measure("measure-geometry-fail.json") });
    expect(a).toEqual(b);
    expect(a.environment).not.toBeNull();
  });
});

describe("measure.json shape", () => {
  it("accepts a recorded document and rejects broken ones with reasons", () => {
    expect(parseMeasure(measure("measure-pass.json")).ok).toBe(true);
    expect(parseMeasure({}).ok).toBe(false);
    const bad = measure("measure-pass.json") as unknown as {
      cases: Record<string, { capture: string; elements: Record<string, unknown> }>;
    };
    bad.cases["projects-desktop-success"]!.capture = "../escape.png";
    bad.cases["projects-desktop-success"]!.elements.cards = { box: "no" };
    const result = parseMeasure(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/capture.*elements\/cards/);
  });
});
