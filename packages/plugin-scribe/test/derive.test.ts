import { describe, expect, it } from "vitest";
import {
  assetKind,
  base64Bytes,
  changedSections,
  formatBytes,
  formatModified,
  jobStages,
  listStatus,
  matchesFilter,
  pdfVersion,
  sectionsOf,
  stepZoom,
  summaryLines,
  texStats,
  // @ts-expect-error -- plain browser module without declarations.
} from "../web/derive.js";

const summary = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  archived: false,
  proposals: 0,
  hasPdf: false,
  ...over,
});

describe("texStats", () => {
  it("counts display math, figures and bibliography entries, ignoring comments", () => {
    const tex = String.raw`
\begin{equation} E = mc^2 \end{equation}
\begin{align*} a &= b \end{align*}
\[ x^2 \]
$$ y $$
% \begin{equation} commented out \end{equation}
50\% of $x$ is inline, not display.
\begin{figure}\includegraphics{a}\includegraphics{b}\end{figure}
\includegraphics{loose}`;
    const bib = "@article{a,title={A}}\n@Book{b,title={B}}\n@comment{skip}\n@string{x = 1}";
    expect(texStats(tex, bib)).toEqual({ equations: 4, figures: 2, references: 2 });
  });

  it("returns zeros for empty input", () => {
    expect(texStats("", undefined)).toEqual({ equations: 0, figures: 0, references: 0 });
  });
});

describe("sections", () => {
  it("lists section and subsection headings in order", () => {
    expect(sectionsOf("\\section{Intro}x\\subsection*{Detail}y\\section{End}")).toEqual([
      "Intro",
      "Detail",
      "End",
    ]);
  });

  it("counts rewritten, added and removed sections, not preamble edits", () => {
    const before = "pre\\section{A} one \\section{B} two \\section{C} three";
    const after = "PRE CHANGED\\section{A}   one\n\\section{B} TWO \\section{D} four";
    expect(changedSections(before, after)).toEqual({ count: 3, names: ["B", "D", "C"] });
    expect(changedSections(before, before)).toEqual({ count: 0, names: [] });
  });
});

describe("summaryLines", () => {
  it("splits on lines and strips bullet markers", () => {
    expect(summaryLines("- First\n* Second\n\n1. Third\n• Fourth")).toEqual([
      "First",
      "Second",
      "Third",
      "Fourth",
    ]);
    expect(summaryLines("a\nb\nc", 2)).toEqual(["a", "b"]);
    expect(summaryLines(undefined)).toEqual([]);
  });
});

describe("library status and filters", () => {
  it("derives draft, review and ready from real data only", () => {
    expect(listStatus(summary())).toBe("draft");
    expect(listStatus(summary({ hasPdf: true }))).toBe("ready");
    expect(listStatus(summary({ hasPdf: true, proposals: 1 }))).toBe("review");
    expect(listStatus(summary(), [{ documentId: "d1", status: "running" }])).toBe("review");
    expect(listStatus(summary(), [{ documentId: "other", status: "running" }])).toBe("draft");
    expect(listStatus(summary(), [{ documentId: "d1", status: "failed" }])).toBe("draft");
  });

  it("keeps archived documents out of every filter but their own", () => {
    const archived = summary({ archived: true });
    expect(matchesFilter(archived, "draft", "all")).toBe(false);
    expect(matchesFilter(archived, "draft", "archived")).toBe(true);
    expect(matchesFilter(summary(), "draft", "archived")).toBe(false);
    expect(matchesFilter(summary(), "review", "progress")).toBe(true);
    expect(matchesFilter(summary(), "ready", "progress")).toBe(false);
    expect(matchesFilter(summary(), "ready", "ready")).toBe(true);
    expect(matchesFilter(summary(), "draft", "all")).toBe(true);
  });
});

describe("formatModified", () => {
  const words = { today: "hoy", yesterday: "ayer" };
  const now = new Date(2026, 10, 9, 15, 0);
  it("uses relative words for today and yesterday", () => {
    expect(formatModified(new Date(2026, 10, 9, 11, 24).toISOString(), "es", words, now)).toMatch(
      /^hoy, 11:24$/,
    );
    expect(formatModified(new Date(2026, 10, 8, 9, 2).toISOString(), "es", words, now)).toMatch(
      /^ayer, 0?9:02$/,
    );
    expect(formatModified(new Date(2026, 0, 3).toISOString(), "en", words, now)).toMatch(/2026/);
    expect(formatModified("not a date", "en", words, now)).toBe("");
  });
});

describe("assets", () => {
  it("computes decoded sizes and readable units", () => {
    expect(base64Bytes(Buffer.from("hello").toString("base64"))).toBe(5);
    expect(base64Bytes(Buffer.from("hell").toString("base64"))).toBe(4);
    expect(base64Bytes(Buffer.alloc(3000).toString("base64"))).toBe(3000);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });

  it("classifies thumbnails by type", () => {
    expect(assetKind({ name: "a.png", mime: "image/png" })).toBe("image");
    expect(assetKind({ name: "d.csv", mime: "text/csv" })).toBe("table");
    expect(assetKind({ name: "r.bib", mime: "text/plain" })).toBe("code");
    expect(assetKind({ name: "p.pdf", mime: "application/pdf" })).toBe("pdf");
    expect(assetKind({ name: "n.txt", mime: "text/plain" })).toBe("text");
  });
});

describe("jobStages", () => {
  it("ties every stage to the real job status", () => {
    const states = (status: string) => jobStages({ status }).map((s: { state: string }) => s.state);
    expect(states("running")).toEqual(["done", "active", "pending"]);
    expect(states("succeeded")).toEqual(["done", "done", "done"]);
    expect(states("failed")).toEqual(["done", "failed", "pending"]);
    expect(states("cancelled")).toEqual(["done", "failed", "pending"]);
  });
});

describe("pdfVersion and zoom", () => {
  it("numbers the revision the PDF was built from", () => {
    const revisions = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    expect(pdfVersion({ revisions, pdf: { revision: "r2" } })).toBe(2);
    expect(pdfVersion({ revisions, pdf: { revision: "gone" } })).toBeNull();
    expect(pdfVersion({ revisions })).toBeNull();
  });

  it("steps through zoom levels and clamps at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.85);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.85);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});
