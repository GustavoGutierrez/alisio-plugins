import { describe, expect, it } from "vitest";
import {
  createFeatureState,
  type FeatureState,
  validateFeatureState,
} from "../src/domain/state/feature-state.js";
import {
  approvalsForLevel,
  levels,
  phasesForLevel,
  requirementsForLevel,
} from "../src/domain/state/levels.js";
import { migrate, NewerSchemaError, openState } from "../src/domain/state/migrations.js";
import { isPhase, nextPhase, phases } from "../src/domain/state/phases.js";

const NOW = "2026-10-06T12:00:00Z";
const fresh = (): FeatureState =>
  createFeatureState({
    feature: "projects",
    intent: "List projects",
    level: "L2",
    mode: "build",
    now: NOW,
  });

describe("phases and levels", () => {
  it("defines the thirteen phases in order", () => {
    expect(phases).toEqual([
      "intake",
      "context",
      "specify",
      "ui-contract",
      "tokens",
      "plan",
      "test-design",
      "build",
      "validate",
      "review",
      "accept",
      "archive",
      "closed",
    ]);
    expect(isPhase("build")).toBe(true);
    expect(isPhase("nope")).toBe(false);
  });

  it("selects the phase list per level", () => {
    expect(phasesForLevel("L0")).toEqual([
      "intake",
      "context",
      "build",
      "validate",
      "review",
      "closed",
    ]);
    expect(phasesForLevel("L1")).toEqual([
      "intake",
      "context",
      "specify",
      "plan",
      "build",
      "validate",
      "review",
      "closed",
    ]);
    expect(phasesForLevel("L2", { tokensNeeded: false })).not.toContain("tokens");
    expect(phasesForLevel("L2", { tokensNeeded: true })).toContain("tokens");
    expect(phasesForLevel("L3", { tokensNeeded: false })).toEqual(
      phasesForLevel("L2", { tokensNeeded: false }),
    );
    expect(phasesForLevel("L2", { tokensNeeded: true }).at(-1)).toBe("closed");
  });

  it("walks to the next phase of a level and ends at closed", () => {
    expect(nextPhase("L0", "context")).toBe("build");
    expect(nextPhase("L1", "specify")).toBe("plan");
    expect(nextPhase("L2", "plan", { tokensNeeded: false })).toBe("test-design");
    expect(nextPhase("L2", "ui-contract", { tokensNeeded: true })).toBe("tokens");
    expect(nextPhase("L2", "ui-contract", { tokensNeeded: false })).toBe("plan");
    expect(nextPhase("L0", "closed")).toBeUndefined();
    expect(nextPhase("L0", "specify")).toBeUndefined();
  });

  it("lists the human approvals and extra requirements per level", () => {
    expect(levels).toEqual(["L0", "L1", "L2", "L3"]);
    expect(approvalsForLevel("L0")).toEqual([]);
    expect(approvalsForLevel("L1")).toEqual(["spec"]);
    expect(approvalsForLevel("L2")).toEqual(["spec", "ui-contract", "plan", "acceptance"]);
    expect(approvalsForLevel("L3")).toEqual([
      "spec",
      "ui-contract",
      "plan",
      "acceptance",
      "review-signoff",
    ]);
    expect(requirementsForLevel("L3")).toEqual({
      adrRequired: true,
      securityRiskRequired: true,
      reviewRuns: 2,
      a11yAuditMandatory: true,
    });
    expect(requirementsForLevel("L2").reviewRuns).toBe(1);
    expect(requirementsForLevel("L2").adrRequired).toBe(false);
  });
});

describe("feature state", () => {
  it("creates a valid initial state", () => {
    const state = fresh();
    expect(state).toMatchObject({
      schemaVersion: 1,
      feature: "projects",
      phase: "intake",
      level: "L2",
      mode: "build",
      attemptSeq: 0,
      tasks: [],
      questions: [],
      counters: { repairRounds: 0, remediations: 0, envelopeRetries: 0 },
      approvals: { dependencies: {} },
    });
    expect(state.createdAt).toBe(NOW);
    expect(validateFeatureState(state)).toEqual({ ok: true, state });
  });

  it("rejects malformed state with a pointer", () => {
    const base = fresh();
    const cases: Array<[string, unknown, string]> = [
      ["bad feature", { ...base, feature: "Bad Id" }, "/feature"],
      ["bad level", { ...base, level: "L9" }, "/level"],
      ["bad phase", { ...base, phase: "cooking" }, "/phase"],
      ["intent too long", { ...base, intent: "x".repeat(4001) }, "/intent"],
      ["tasks not array", { ...base, tasks: {} }, "/tasks"],
      [
        "bad task status",
        {
          ...base,
          tasks: [
            { id: "T-001", layer: "ui", status: "x", bounces: 0, changedPaths: [], origin: "plan" },
          ],
        },
        "/tasks/0/status",
      ],
      ["not an object", 7, ""],
    ];
    for (const [, raw, pointer] of cases) {
      const result = validateFeatureState(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.pointer === pointer)).toBe(true);
    }
  });
});

describe("optional source and answer provenance (additive, schemaVersion stays 1)", () => {
  it("accepts a state with a source reference and a dialog answer", () => {
    const state = fresh();
    state.source = {
      path: "specs/a.md",
      format: "markdown",
      sha256: "ab".repeat(32),
      bytes: 10,
      snapshot: "docs/frontsmith/projects/source-spec.md",
      importedAt: NOW,
    };
    state.questions.push({
      id: "Q-01",
      question: "q",
      blocking: true,
      answer: "a",
      answeredVia: "dialog",
    });
    expect(validateFeatureState(state)).toMatchObject({ ok: true });
    expect(state.schemaVersion).toBe(1);
  });

  it("rejects a malformed source reference", () => {
    const state = { ...fresh(), source: { path: 3 } };
    const result = validateFeatureState(state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.pointer)).toContain("/source");
  });

  it("accepts a state without them (a 0.1.0 state)", () => {
    expect(validateFeatureState(fresh())).toMatchObject({ ok: true });
  });
});

describe("state migrations", () => {
  it("is the identity for version 1 after validation", () => {
    const state = fresh();
    expect(migrate(structuredClone(state))).toEqual(state);
  });

  it("refuses a newer schemaVersion for mutation but opens it read-only", () => {
    const newer = { ...fresh(), schemaVersion: 2 };
    expect(() => migrate(newer)).toThrow(NewerSchemaError);
    try {
      migrate(newer);
    } catch (error) {
      expect((error as Error).message).toBe(
        "State written by a newer Frontsmith (schemaVersion 2); upgrade the plugin",
      );
    }
    const opened = openState(newer);
    expect(opened.readOnly).toBe(true);
    expect(opened.version).toBe(2);
    expect(opened.state?.feature).toBe("projects");
    expect(openState(fresh()).readOnly).toBe(false);
  });

  it("rejects missing or invalid schema versions", () => {
    expect(() => migrate({ ...fresh(), schemaVersion: 0 })).toThrow();
    expect(() => migrate({})).toThrow();
    expect(() => migrate(null)).toThrow();
  });
});
