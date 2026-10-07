import { describe, expect, it } from "vitest";
import {
  type AuditReport,
  auditFindings,
  auditScript,
  parseAuditReport,
} from "../src/layout/audit.js";

const empty = (): AuditReport => ({
  overflow: [],
  overlap: [],
  minSize: [],
  mathScaled: [],
  answerSpace: [],
});

describe("in-page audit (EVL-LAY-002, EVL-LAY-004)", () => {
  it("emits the audit script", () => {
    const script = auditScript();
    expect(script).toContain("answer-space");
    expect(script).toContain("katex-display");
    expect(script.startsWith("(() =>")).toBe(true);
  });

  it("validates a browser report", () => {
    expect(parseAuditReport(empty())).toEqual(empty());
    expect(parseAuditReport({ overflow: [] })).toBeUndefined();
    expect(parseAuditReport("nope")).toBeUndefined();
    expect(parseAuditReport({ ...empty(), overflow: [1] })).toBeUndefined();
  });

  it("maps problems to EVL-LAY-002 and a wide formula to EVL-LAY-004", () => {
    expect(auditFindings(empty())).toEqual([]);
    const overflow = auditFindings({ ...empty(), overflow: ["item"] });
    expect(overflow[0]).toMatchObject({ id: "EVL-LAY-002", severity: "error" });
    const overlap = auditFindings({ ...empty(), overlap: ["item 2"] });
    expect(overlap.map((finding) => finding.id)).toContain("EVL-LAY-002");
    const math = auditFindings({ ...empty(), mathScaled: ["display"] });
    expect(math[0]).toMatchObject({ id: "EVL-LAY-004", severity: "warning" });
  });
});
