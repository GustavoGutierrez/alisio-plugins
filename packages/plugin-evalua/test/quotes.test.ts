import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { shippedQuotesDir } from "../src/knowledge/package.js";
import { loadQuotes, loadQuotesLayers, type QuoteEntry, selectClosing } from "../src/quotes.js";
import { cleanup, scratchDir } from "./helpers/harness.js";

afterEach(cleanup);

let entries: QuoteEntry[];

beforeAll(async () => {
  const catalogue = await loadQuotes(shippedQuotesDir());
  entries = catalogue.entries;
});

describe("quotes catalogue", () => {
  it("loads clean and every entry names a source with non-trivial text", () => {
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const entry of entries) {
      expect(entry.source.trim().length).toBeGreaterThan(0);
      expect(entry.text.trim().length).toBeGreaterThanOrEqual(20);
      expect(entry.language).toBe("es");
    }
  });

  it("ships the public-domain Reina-Valera 1909 verses from a named source", () => {
    const bible = entries.filter((entry) => entry.kind === "bible");
    expect(bible).toHaveLength(22);
    for (const entry of bible) {
      expect(entry.reference).toBeTruthy();
      expect(entry.source).toContain("spaRV1909");
    }
  });
});

describe("selectClosing", () => {
  const base = () => ({
    language: "es",
    keywords: ["knowledge", "logic"],
    examId: "e01",
    entries,
  });

  it("returns nothing for kind none", () => {
    expect(selectClosing({ ...base(), kind: "none" })).toEqual({});
  });

  it("is deterministic and prefers tag overlap", () => {
    const first = selectClosing({ ...base(), kind: "quote" });
    const second = selectClosing({ ...base(), kind: "quote" });
    expect(first.entry?.id).toBe(second.entry?.id);
    expect(first.entry?.tags).toContain("knowledge");
  });

  it("selects a bible entry for the bible kind", () => {
    const selection = selectClosing({ ...base(), kind: "bible" });
    expect(selection.entry?.kind).toBe("bible");
  });

  it("honours a pinned id and a teacher text verbatim", () => {
    const pinned = selectClosing({ ...base(), kind: "quote", pinned: "euclid-no-royal-road" });
    expect(pinned.entry?.id).toBe("euclid-no-royal-road");
    const teacher = selectClosing({
      ...base(),
      kind: "quote",
      teacherText: "Sigue adelante con esfuerzo.",
    });
    expect(teacher).toEqual({ teacherText: "Sigue adelante con esfuerzo." });
  });

  it("treats an unknown pinned value as teacher text", () => {
    const selection = selectClosing({ ...base(), kind: "quote", pinned: "Una frase propia." });
    expect(selection).toEqual({ teacherText: "Una frase propia." });
  });
});

describe("workspace quotes layer", () => {
  it("overrides a shipped entry and adds a teacher entry", async () => {
    const dir = await scratchDir();
    await writeFile(
      join(dir, "quotes.yaml"),
      [
        "- id: galileo-universe",
        '  text: "Texto del docente con longitud suficiente para pasar el minimo."',
        '  source: "Fuente del docente."',
        "  tags: [logic]",
        "  language: es",
        "- id: custom-teacher-quote",
        '  text: "Otra cita propia del docente con longitud suficiente."',
        '  source: "Fuente propia."',
        "  tags: [knowledge]",
        "  language: es",
      ].join("\n"),
    );
    const catalogue = await loadQuotesLayers([
      { dir: shippedQuotesDir(), layer: "shipped" },
      { dir, layer: "workspace" },
    ]);
    expect(catalogue.report.ok).toBe(true);
    expect(catalogue.entries.find((entry) => entry.id === "galileo-universe")?.text).toContain(
      "docente",
    );
    expect(catalogue.entries.some((entry) => entry.id === "custom-teacher-quote")).toBe(true);
  });
});
