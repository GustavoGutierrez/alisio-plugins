import { describe, expect, it } from "vitest";
import { fitIsCurrent, renderReport } from "../src/render.js";
import { initialReport, PALETTES, type Report } from "../src/types.js";

function report(patch: Partial<Report> = {}): Report {
  return { ...initialReport({ name: "Demo", language: "en" }), ...patch };
}

describe("renderReport", () => {
  it("escapes every user and model string", () => {
    const r = report({
      title: "<script>alert(1)</script>",
      blocks: [{ id: "p", type: "paragraph", text: "<img src=x onerror=alert(1)>" }],
    });
    const html = renderReport(r);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("changes chart colors with the palette, without a model call", () => {
    const r = report({
      blocks: [{ id: "b", type: "bars", title: "Sales", labels: ["A", "B"], values: [10, 20] }],
    });
    const one = renderReport(r);
    r.palette = PALETTES[2] as never;
    const two = renderReport(r);
    expect(one).not.toBe(two);
    expect(two).toContain(PALETTES[2]?.accent);
  });

  it("is self-contained: no scripts, no remote resources", () => {
    const html = renderReport(
      report({
        blocks: [{ id: "d", type: "donut", title: "Mix", labels: ["a", "b"], values: [1, 3] }],
      }),
    );
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
  });

  it("prints multipage reports without a zoom", () => {
    const html = renderReport(report());
    expect(html).toContain("@page{size:A4;margin:12mm}");
    expect(html).not.toMatch(/zoom:/);
  });

  it("zooms a single-page report by its current fit when printing", () => {
    const r = report({ mode: "singlepage", pageSize: "Letter" });
    r.fit = {
      scale: 0.637,
      width: 725,
      height: 1515,
      pageSize: "Letter",
      revision: r.revision,
      columns: r.columns,
    };
    expect(fitIsCurrent(r)).toBe(true);
    const html = renderReport(r);
    expect(html).toContain("@page{size:letter;margin:12mm}");
    expect(html).toMatch(
      /@media print\{[\s\S]*\.document\{width:725px\}[\s\S]*\.document\{zoom:0\.637\}\}/,
    );
    expect(html).toContain('data-print-scale="0.637"');
  });

  it("ignores a stale fit (other revision, page size or columns)", () => {
    const r = report({ mode: "singlepage" });
    r.fit = {
      scale: 0.5,
      width: 702,
      height: 2062,
      pageSize: "A4",
      revision: r.revision - 1,
      columns: r.columns,
    };
    expect(fitIsCurrent(r)).toBe(false);
    expect(renderReport(r)).toContain(".document{zoom:1}");
    r.fit = { ...r.fit, revision: r.revision, pageSize: "Letter" };
    expect(fitIsCurrent(r)).toBe(false);
    r.fit = { ...r.fit, pageSize: "A4", columns: 3 };
    expect(fitIsCurrent(r)).toBe(false);
  });

  it("renders the measuring layout on screen at the printable width, unzoomed", () => {
    const html = renderReport(report({ mode: "singlepage" }), { measure: true });
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const screen = css.slice(0, css.lastIndexOf("@media print"));
    expect(screen).toContain(".document{width:702px}");
    expect(screen).toContain(".hero h1{font-size:52px}");
    expect(css).not.toMatch(/zoom:/);
  });
});
