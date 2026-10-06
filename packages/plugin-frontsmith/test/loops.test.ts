import { describe, expect, it } from "vitest";
import {
  bounceDecision,
  groupFindingsByFile,
  remediationDecision,
  repairDecision,
} from "../src/application/workflow/loops.js";
import {
  defaultBudgets,
  evaluateBundle,
  kib,
  validateBudgets,
} from "../src/domain/budgets/evaluate.js";

describe("bounce (G6 FAIL, same child session, spec 7.3)", () => {
  it("bounces until maxBounces and then blocks the task", () => {
    expect(bounceDecision({ bounces: 0, max: 2 })).toEqual({ action: "bounce", attempt: 1 });
    expect(bounceDecision({ bounces: 1, max: 2 })).toEqual({ action: "bounce", attempt: 2 });
    expect(bounceDecision({ bounces: 2, max: 2 })).toEqual({
      action: "blocked",
      reason: "bounce limit of 2 reached",
    });
  });

  it("with maxBounces 0 the first failure blocks", () => {
    expect(bounceDecision({ bounces: 0, max: 0 })).toMatchObject({ action: "blocked" });
  });
});

describe("repair rounds (G7 FAIL, spec 7.3)", () => {
  it("stops with done when nothing fails", () => {
    expect(repairDecision({ round: 0, max: 3, previousFailures: undefined, failures: 0 })).toEqual({
      action: "done",
    });
  });

  it("repairs while the number of failures strictly decreases, up to the bound", () => {
    expect(repairDecision({ round: 0, max: 3, previousFailures: undefined, failures: 5 })).toEqual({
      action: "repair",
      round: 1,
    });
    expect(repairDecision({ round: 1, max: 3, previousFailures: 5, failures: 3 })).toEqual({
      action: "repair",
      round: 2,
    });
    expect(repairDecision({ round: 2, max: 3, previousFailures: 3, failures: 1 })).toEqual({
      action: "repair",
      round: 3,
    });
  });

  it("stops at once when a round does not strictly decrease the failures (no-improvement stop)", () => {
    expect(repairDecision({ round: 1, max: 3, previousFailures: 3, failures: 3 })).toMatchObject({
      action: "stop",
      reason: "no-improvement",
    });
    expect(repairDecision({ round: 1, max: 3, previousFailures: 3, failures: 4 })).toMatchObject({
      action: "stop",
      reason: "no-improvement",
    });
  });

  it("stops as exhausted when the bound is reached with failures left", () => {
    expect(repairDecision({ round: 3, max: 3, previousFailures: 3, failures: 2 })).toMatchObject({
      action: "stop",
      reason: "exhausted",
    });
    expect(
      repairDecision({ round: 0, max: 0, previousFailures: undefined, failures: 1 }),
    ).toMatchObject({ action: "stop", reason: "exhausted" });
  });
});

describe("remediation (G8 BLOCKER or MAJOR, spec 7.3)", () => {
  it("remediates up to maxRemediations and then stops", () => {
    expect(remediationDecision({ remediations: 0, max: 2, open: 1 })).toEqual({
      action: "remediate",
      round: 1,
    });
    expect(remediationDecision({ remediations: 1, max: 2, open: 1 })).toEqual({
      action: "remediate",
      round: 2,
    });
    expect(remediationDecision({ remediations: 2, max: 2, open: 1 })).toMatchObject({
      action: "stop",
    });
    expect(remediationDecision({ remediations: 0, max: 2, open: 0 })).toEqual({ action: "done" });
  });
});

describe("grouping findings into repair tasks", () => {
  it("groups by file in stable order and puts file-less findings together", () => {
    const groups = groupFindingsByFile([
      { id: "F-0003", file: "src/b.ts" },
      { id: "F-0001", file: "src/a.ts" },
      { id: "F-0002", file: "src/a.ts" },
      { id: "F-0004" },
    ]);
    expect(groups).toEqual([
      { file: "src/a.ts", findingIds: ["F-0001", "F-0002"] },
      { file: "src/b.ts", findingIds: ["F-0003"] },
      { file: undefined, findingIds: ["F-0004"] },
    ]);
  });
});

describe("budgets (spec 10.6)", () => {
  const measured = {
    initialJsGzipBytes: 60_000,
    initialCssGzipBytes: 10_000,
    entryFiles: ["dist/assets/index-a.js"],
    cssFiles: ["dist/assets/index-a.css"],
  };
  const strict = true;

  it("does not check a null absolute limit (no invented universal numbers)", () => {
    const lines = evaluateBundle({
      config: defaultBudgets(),
      measured,
      baseline: { initialJsGzipBytes: 60_000, initialCssGzipBytes: 10_000 },
      strict,
    });
    expect(lines.find((l) => l.id === "initialJs")).toMatchObject({ status: "SKIPPED" });
    expect(lines.find((l) => l.id === "delta")).toMatchObject({ status: "PASS" });
  });

  it("fails an absolute limit over the gzip size and passes within it", () => {
    const config = {
      ...defaultBudgets(),
      bundle: { ...defaultBudgets().bundle, maxInitialJsGzipKb: 50 },
    };
    expect(
      evaluateBundle({ config, measured, baseline: undefined, strict: false }).find(
        (l) => l.id === "initialJs",
      ),
    ).toMatchObject({ status: "FAIL", summary: "58.6 KiB gzip exceeds 50 KiB" });
    const roomy = { ...config, bundle: { ...config.bundle, maxInitialJsGzipKb: 100 } };
    expect(
      evaluateBundle({ config: roomy, measured, baseline: undefined, strict: false }).find(
        (l) => l.id === "initialJs",
      ),
    ).toMatchObject({ status: "PASS" });
  });

  it("blocks when no build output matches the globs", () => {
    const config = {
      ...defaultBudgets(),
      bundle: { ...defaultBudgets().bundle, maxInitialJsGzipKb: 50 },
    };
    expect(
      evaluateBundle({ config, measured: undefined, baseline: undefined, strict }).find(
        (l) => l.id === "initialJs",
      ),
    ).toMatchObject({ status: "BLOCKED" });
  });

  it("compares the delta with the recorded baseline; no baseline is BLOCKED when strict and SKIPPED otherwise", () => {
    const config = defaultBudgets();
    const grew = evaluateBundle({
      config,
      measured,
      baseline: { initialJsGzipBytes: 40_000, initialCssGzipBytes: 5_000 },
      strict,
    });
    expect(grew.find((l) => l.id === "delta")).toMatchObject({ status: "FAIL" });
    expect(
      evaluateBundle({ config, measured, baseline: undefined, strict: true }).find(
        (l) => l.id === "delta",
      ),
    ).toMatchObject({ status: "BLOCKED" });
    expect(
      evaluateBundle({ config, measured, baseline: undefined, strict: false }).find(
        (l) => l.id === "delta",
      ),
    ).toMatchObject({ status: "SKIPPED" });
    const none = { ...config, bundle: { ...config.bundle, maxDeltaGzipKb: null } };
    expect(
      evaluateBundle({ config: none, measured, baseline: undefined, strict }).find(
        (l) => l.id === "delta",
      ),
    ).toMatchObject({ status: "SKIPPED" });
  });

  it("formats sizes in KiB with one decimal", () => {
    expect(kib(1536)).toBe("1.5 KiB");
  });

  it("validates budgets.json: defaults fill gaps, unknown keys and wrong types are diagnostics", () => {
    expect(validateBudgets({ schemaVersion: 1 })).toEqual({ ok: true, config: defaultBudgets() });
    const custom = validateBudgets({
      schemaVersion: 1,
      bundle: { maxInitialJsGzipKb: 120, maxDeltaGzipKb: null },
      images: { maxBytes: 100000 },
    });
    expect(custom).toMatchObject({
      ok: true,
      config: {
        bundle: { maxInitialJsGzipKb: 120, maxDeltaGzipKb: null },
        images: { maxBytes: 100000, maxWidthPx: 2560 },
      },
    });
    const bad = validateBudgets({
      schemaVersion: 2,
      bundle: { dir: "/abs", maxInitialJsGzipKb: -1, extra: 1 },
      other: true,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.diagnostics.map((d) => d.pointer).sort()).toEqual([
        "/bundle/dir",
        "/bundle/extra",
        "/bundle/maxInitialJsGzipKb",
        "/other",
        "/schemaVersion",
      ]);
    expect(validateBudgets("x").ok).toBe(false);
  });
});
