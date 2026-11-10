import { describe, expect, it } from "vitest";
import { CHUNK_CAP, CHUNK_OVERLAP, CHUNK_TARGET, chunkSegments } from "../src/notebook/chunk.js";

const sentence = (i: number) => `Sentence number ${i} talks about a topic in plain words. `;
const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i))
    .join("")
    .trim();

describe("chunker (§7.4, SEM-AC-08)", () => {
  it("packs paragraphs to the target with overlap and exact source ranges", () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i * 5, 5)).join("\n\n");
    const { text: full, chunks } = chunkSegments([{ text, page: null }]);
    expect(full).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.ordinal).toBe(i);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET);
      expect(full.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
      expect(chunk.page).toBeNull();
    });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (!prev || !next) continue;
      expect(next.charStart).toBeLessThan(prev.charEnd);
      expect(prev.charEnd - next.charStart).toBeLessThanOrEqual(CHUNK_OVERLAP);
      expect(next.charEnd).toBeGreaterThan(prev.charEnd);
    }
    expect(chunks.at(-1)?.charEnd).toBe(full.length);
  });

  it("splits a 5 000-character paragraph by sentence and never exceeds the cap", () => {
    const long = paragraph(0, 100);
    expect(long.length).toBeGreaterThan(5000);
    const { chunks } = chunkSegments([{ text: long, page: null }]);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CAP);
      expect(chunk.text.length).toBeGreaterThan(200);
    }
  });

  it("splits text without sentence or whitespace boundaries at the hard cap", () => {
    const { chunks } = chunkSegments([{ text: "x".repeat(6000), page: null }]);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CAP);
    expect(chunks.map((c) => c.text).join("").length).toBeGreaterThanOrEqual(6000);
  });

  it("never crosses a PDF page boundary and keeps the page number", () => {
    const pages = [paragraph(0, 30), "Short page two.", paragraph(100, 30)];
    const { text, chunks } = chunkSegments(pages.map((p, i) => ({ text: p, page: i + 1 })));
    expect(new Set(chunks.map((c) => c.page))).toEqual(new Set([1, 2, 3]));
    for (const chunk of chunks) {
      const page = pages[(chunk.page ?? 0) - 1] ?? "";
      expect(page).toContain(chunk.text);
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("splits long line-based text (spreadsheet rows) at line ends, never mid-row", () => {
    const rows = Array.from({ length: 300 }, (_, i) => `Row ${i}\tNorth\t${i * 3}.5\tTRUE`);
    const sheets = [
      { text: `Sheet: A\n${rows.join("\n")}`, page: 1 },
      { text: "Sheet: B\nx\ty", page: 2 },
    ];
    const { chunks } = chunkSegments(sheets);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET);
      for (const line of chunk.text.split("\n"))
        expect(
          line === "Sheet: A" ||
            line === "Sheet: B" ||
            /^Row \d+\tNorth\t\d+\.5\tTRUE$/.test(line) ||
            line === "x\ty",
        ).toBe(true);
    }
    expect(chunks.at(-1)).toMatchObject({ page: 2, text: "Sheet: B\nx\ty" });
  });

  it("skips blank segments and blank text", () => {
    expect(chunkSegments([{ text: "  \n\n  ", page: 1 }]).chunks).toEqual([]);
  });
});
