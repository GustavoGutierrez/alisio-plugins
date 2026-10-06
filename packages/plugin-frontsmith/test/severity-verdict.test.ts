import { describe, expect, it } from "vitest";
import { atLeastSeverity, compareSeverity, severities } from "../src/domain/severity.js";
import { aggregate, type CheckStatus, statusForFinding } from "../src/domain/verdict.js";

describe("severity", () => {
  it("orders blocker above nit", () => {
    expect(severities).toEqual(["blocker", "major", "minor", "nit"]);
    expect(compareSeverity("blocker", "major")).toBeLessThan(0);
    expect(compareSeverity("nit", "minor")).toBeGreaterThan(0);
    expect(atLeastSeverity("major", "minor")).toBe(true);
    expect(atLeastSeverity("nit", "minor")).toBe(false);
    expect(atLeastSeverity("minor", "minor")).toBe(true);
  });
});

describe("finding status", () => {
  it("maps deterministic severities as FID 15.10 requires", () => {
    expect(statusForFinding("blocker", "deterministic")).toBe("FAIL");
    expect(statusForFinding("major", "deterministic")).toBe("FAIL");
    expect(statusForFinding("minor", "deterministic")).toBe("REVIEW");
    expect(statusForFinding("nit", "deterministic")).toBe("PASS");
  });

  it("caps heuristic rules at REVIEW", () => {
    expect(statusForFinding("blocker", "heuristic")).toBe("REVIEW");
    expect(statusForFinding("major", "heuristic")).toBe("REVIEW");
    expect(statusForFinding("minor", "heuristic")).toBe("REVIEW");
    expect(statusForFinding("nit", "heuristic")).toBe("PASS");
  });

  it("turns waived or suppressed findings into PASS", () => {
    expect(statusForFinding("blocker", "deterministic", { waived: true })).toBe("PASS");
    expect(statusForFinding("minor", "deterministic", { suppressed: true })).toBe("PASS");
  });
});

describe("aggregate", () => {
  const check = (status: CheckStatus, required = true) => ({ status, required });

  it("lets any FAIL win, then required BLOCKED, then REVIEW, then PASS", () => {
    expect(aggregate([check("PASS"), check("FAIL", false), check("BLOCKED")]).verdict).toBe("FAIL");
    expect(aggregate([check("PASS"), check("BLOCKED"), check("REVIEW")]).verdict).toBe("BLOCKED");
    expect(aggregate([check("PASS"), check("REVIEW")]).verdict).toBe("REVIEW");
    expect(aggregate([check("PASS"), check("PASS")]).verdict).toBe("PASS");
  });

  it("ignores optional BLOCKED checks and SKIPPED checks", () => {
    expect(aggregate([check("PASS"), check("BLOCKED", false)]).verdict).toBe("PASS");
    expect(aggregate([check("PASS"), check("SKIPPED")]).verdict).toBe("PASS");
  });

  it("reports coverage and never averages", () => {
    const result = aggregate([check("PASS"), check("PASS"), check("BLOCKED"), check("SKIPPED")]);
    expect(result.coverage).toEqual({ required: 3, executed: 2, pending: 1 });
    expect(result.verdict).toBe("BLOCKED");
  });

  it("counts only required, non-SKIPPED checks and never treats SKIPPED as evidence", () => {
    const result = aggregate([
      check("PASS"),
      check("SKIPPED"),
      check("SKIPPED", false),
      check("BLOCKED", false),
      check("REVIEW"),
    ]);
    expect(result.coverage).toEqual({ required: 2, executed: 2, pending: 0 });
    expect(result.verdict).toBe("REVIEW");
    expect(aggregate([check("PASS"), check("BLOCKED")]).coverage).toEqual({
      required: 2,
      executed: 1,
      pending: 1,
    });
    expect(aggregate([]).coverage).toEqual({ required: 0, executed: 0, pending: 0 });
  });

  it("treats an empty check list as BLOCKED because nothing was evidenced", () => {
    expect(aggregate([]).verdict).toBe("BLOCKED");
  });
});
