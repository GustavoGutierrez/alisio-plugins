import { describe, expect, it } from "vitest";
import {
  isFeatureId,
  isPackId,
  isShippedRuleId,
  isWorkspaceRuleId,
  matchesId,
} from "../src/domain/ids.js";

describe("identifiers", () => {
  it("accepts well formed feature ids and rejects the rest", () => {
    for (const ok of ["a", "projects", "x1-y2", "a".repeat(48)]) expect(isFeatureId(ok)).toBe(true);
    for (const bad of ["", "A", "-a", "a_b", "a/b", "../x", "a".repeat(49), "a b", "a\u0000"])
      expect(isFeatureId(bad)).toBe(false);
  });

  it("matches the envelope id patterns of the child contract", () => {
    expect(matchesId("requirement", "R-01")).toBe(true);
    expect(matchesId("requirement", "R-1")).toBe(false);
    expect(matchesId("acceptance", "AC-123")).toBe(true);
    expect(matchesId("acceptance", "AC-1234")).toBe(false);
    expect(matchesId("state", "ST-empty")).toBe(true);
    expect(matchesId("state", "ST-Empty")).toBe(false);
    expect(matchesId("question", "Q-07")).toBe(true);
    expect(matchesId("task", "T-001")).toBe(true);
    expect(matchesId("task", "T-01")).toBe(false);
    expect(matchesId("adr", "ADR-003")).toBe(true);
    expect(matchesId("element", "primary-cta")).toBe(true);
    expect(matchesId("element", "P")).toBe(false);
    expect(matchesId("case", "desktop-empty")).toBe(true);
    expect(matchesId("fidelityRule", "GEO-01")).toBe(true);
    expect(matchesId("fidelityRule", "XYZ-01")).toBe(false);
    expect(matchesId("pattern", "PAT-VARIANT-MAP")).toBe(true);
    expect(matchesId("candidate", "CAND-001")).toBe(true);
  });

  it("separates shipped and workspace rule ids", () => {
    expect(isShippedRuleId("FS-CSS-001")).toBe(true);
    expect(isShippedRuleId("FS-DSN-UI01")).toBe(true);
    expect(isShippedRuleId("FS-A11Y-001")).toBe(true);
    expect(isShippedRuleId("ACME-UI-001")).toBe(false);
    expect(isWorkspaceRuleId("ACME-UI-001")).toBe(true);
    expect(isWorkspaceRuleId("FS-CSS-001")).toBe(false);
    expect(isWorkspaceRuleId("FS-ACME-001")).toBe(false);
  });

  it("validates pack ids", () => {
    expect(isPackId("fs-css")).toBe(true);
    expect(isPackId("acme-ui")).toBe(true);
    expect(isPackId("Acme")).toBe(false);
    expect(isPackId("a")).toBe(false);
    expect(isPackId("../x")).toBe(false);
  });
});
