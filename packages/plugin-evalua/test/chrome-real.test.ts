import { describe, expect, it } from "vitest";
import { printHtmlToPdf } from "../src/chrome/cdp.js";
import { detectChrome } from "../src/chrome/detect.js";
import { auditScript, parseAuditReport } from "../src/layout/audit.js";
import { countPdfPages } from "../src/layout.js";

const enabled = process.env.ALISIO_EVALUA_REAL_CHROME === "1";

describe.runIf(enabled)("real Chrome", () => {
  it("prints HTML to a PDF, counts its pages and runs the in-page audit", async () => {
    const detection = await detectChrome();
    if (detection.path === undefined) throw new Error("no Chrome found");
    const result = await printHtmlToPdf({
      executable: detection.path,
      html: "<!doctype html><html><body><h1>Hola</h1><p>Evalua</p></body></html>",
      auditScript: auditScript(),
      timeoutMs: 60_000,
    });
    expect(result.engineVersion).toMatch(/Chrome/);
    const pages = countPdfPages(result.pdf);
    expect(pages.leafPages).toBeGreaterThanOrEqual(1);
    expect(pages.agreement).toBe(true);
    const report = parseAuditReport(result.audit);
    expect(report).toBeDefined();
    expect(report?.overflow).toEqual([]);
  }, 90_000);
});
