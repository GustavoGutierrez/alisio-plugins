import { describe, expect, it } from "vitest";
import {
  applyApproval,
  applyRejection,
  approvalCommand,
  approvalToLeave,
  gateOfPhase,
  parseApprovalTarget,
  rejectCommand,
} from "../src/application/workflow/approvals.js";
import { createFeatureState, type FeatureState } from "../src/domain/state/feature-state.js";
import type { Level } from "../src/domain/state/levels.js";

const NOW = "2026-10-06T12:00:00.000Z";
const state = (level: Level = "L2"): FeatureState =>
  createFeatureState({ feature: "projects", intent: "x", level, mode: "build", now: NOW });

describe("approval targets", () => {
  it("parses the documented targets and rejects anything else", () => {
    for (const ok of [
      "spec",
      "ui-contract",
      "plan",
      "acceptance",
      "config",
      "review-signoff",
      "dependency",
    ])
      expect(parseApprovalTarget(ok)).toBe(ok);
    for (const bad of ["", "SPEC", "uiContract", "everything", "dependency x"])
      expect(parseApprovalTarget(bad)).toBeUndefined();
  });

  it("builds the exact commands a person must run", () => {
    expect(approvalCommand("projects", "spec")).toBe("/frontsmith:approve projects spec");
    expect(approvalCommand("projects", "dependency", "zod")).toBe(
      "/frontsmith:approve projects dependency zod",
    );
    expect(rejectCommand("projects", "plan")).toBe(
      "/frontsmith:reject projects plan -- <comments>",
    );
  });
});

describe("which approval leaves a phase", () => {
  it("follows the level (spec 7.1)", () => {
    expect(approvalToLeave(state("L0"), "specify")).toBeUndefined();
    expect(approvalToLeave(state("L1"), "specify")).toBe("spec");
    expect(approvalToLeave(state("L1"), "plan")).toBeUndefined();
    expect(approvalToLeave(state("L2"), "ui-contract")).toBe("ui-contract");
    expect(approvalToLeave(state("L2"), "plan")).toBe("plan");
    expect(approvalToLeave(state("L2"), "accept")).toBe("acceptance");
    expect(approvalToLeave(state("L2"), "review")).toBeUndefined();
    expect(approvalToLeave(state("L3"), "review")).toBe("review-signoff");
  });

  it("is satisfied once the approval is recorded", () => {
    const s = state("L2");
    applyApproval(s, "spec", { now: NOW, hashes: { "docs/frontsmith/projects/spec.json": "abc" } });
    expect(approvalToLeave(s, "specify")).toBeUndefined();
    expect(s.approvals.spec).toEqual({
      at: NOW,
      by: "human",
      hashes: { "docs/frontsmith/projects/spec.json": "abc" },
    });
    expect(s.protected).toEqual({ "docs/frontsmith/projects/spec.json": "abc" });
  });

  it("maps phases to their gates", () => {
    expect(gateOfPhase("context")).toBe("G0");
    expect(gateOfPhase("tokens")).toBe("G2T");
    expect(gateOfPhase("accept")).toBe("G9");
    expect(gateOfPhase("intake")).toBeUndefined();
    expect(gateOfPhase("build")).toBeUndefined();
  });
});

describe("applying approvals", () => {
  it("records a dependency approval by name and a note", () => {
    const s = state();
    applyApproval(s, "dependency", { now: NOW, name: "zod", note: "reviewed" });
    expect(s.approvals.dependencies.zod).toEqual({ at: NOW, by: "human", note: "reviewed" });
  });

  it("records review sign-off and acceptance in their slots", () => {
    const s = state("L3");
    applyApproval(s, "review-signoff", { now: NOW });
    applyApproval(s, "acceptance", { now: NOW });
    expect(s.approvals.reviewSignoff?.at).toBe(NOW);
    expect(s.approvals.acceptance?.at).toBe(NOW);
  });
});

describe("rejecting", () => {
  it("returns to the producing phase, drops the approval, the later gates and keeps the comments for the next prompt", () => {
    const s = state();
    s.phase = "plan";
    applyApproval(s, "spec", { now: NOW });
    s.gates = {
      G1: { verdict: "PASS", reportPath: "a", at: NOW },
      G3: { verdict: "PASS", reportPath: "b", at: NOW },
      G0: { verdict: "PASS", reportPath: "c", at: NOW },
    };
    const phase = applyRejection(s, "spec", "Add an offline state.");
    expect(phase).toBe("specify");
    expect(s.phase).toBe("specify");
    expect(s.approvals.spec).toBeUndefined();
    expect(Object.keys(s.gates)).toEqual(["G0"]);
    expect(s.feedback).toEqual({ spec: ["Add an offline state."] });
    applyRejection(s, "spec", "And a forbidden state.");
    expect(s.feedback?.spec).toEqual(["Add an offline state.", "And a forbidden state."]);
  });

  it("sends a rejected plan back to plan and a rejected acceptance back to build", () => {
    const s = state();
    s.phase = "accept";
    expect(applyRejection(s, "plan", "Split T-002.")).toBe("plan");
    s.phase = "accept";
    expect(applyRejection(s, "acceptance", "The empty state is wrong.")).toBe("build");
  });

  it("caps the stored comments", () => {
    const s = state();
    applyRejection(s, "spec", "x".repeat(10000));
    expect(s.feedback?.spec?.[0]?.length).toBe(4000);
  });
});
