import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bibtexEntry, generateBibtex } from "../src/research/bibtex.js";
import { parseLibraryText, validateEvidenceRecord } from "../src/research/library.js";
import type { EvidenceRecord } from "../src/types.js";
import { cleanup } from "./helpers/harness.js";
import { drafted, researched } from "./helpers/phase5.js";

afterEach(cleanup);

const root = join(import.meta.dirname, "..");
const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0]?.text ?? "";
const noEngine = {
  coordinator: { env: { LANG: "es_CO.UTF-8", ALISIO_THESIS_TYPST: "/nonexistent/typst" } },
};

const book = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: "EVD-00001",
  citeKey: "garcia2019",
  type: "book",
  title: "Metodología de la investigación aplicada",
  authors: [{ family: "García Torres", given: "María" }],
  year: 2019,
  publisher: "Editorial Ejemplo",
  retrievedAt: "2026-10-04",
  verification: {
    method: "crossref",
    metadataMatch: 1,
    retracted: false,
    checkedAt: "2026-10-04T00:00:00.000Z",
  },
  status: "VERIFIED_AUTHORITATIVE_GREY",
  appraisal: { relevance: "high", evidenceType: "book", limitations: [], supports: [] },
  permittedUse: ["background"],
  sections: ["SEC-01"],
  ...over,
});

describe("placeOfPublication", () => {
  it("is an optional string of the evidence record and becomes the BibTeX address", () => {
    expect(validateEvidenceRecord(book({ placeOfPublication: "Bogotá" }))).toEqual([]);
    expect(validateEvidenceRecord({ ...book(), placeOfPublication: 7 })).toContain(
      "placeOfPublication must be a string",
    );
    expect(bibtexEntry(book({ placeOfPublication: "Bogotá" }))).toContain(
      "  address = {Bogotá},\n",
    );
    expect(bibtexEntry(book())).not.toContain("address");
    const text = `${JSON.stringify(book({ placeOfPublication: "Medellín" }))}\n`;
    expect(parseLibraryText(text).errors).toEqual([]);
    expect(generateBibtex(parseLibraryText(text).records)).toContain("address = {Medellín}");
  });

  it("is printed by the ICONTEC golden fixtures", async () => {
    const golden = JSON.parse(
      await readFile(
        join(root, "styles", "fixtures", "icontec-ntc1486-2022.expected.json"),
        "utf8",
      ),
    );
    expect(golden.bibliography.book).toContain("Bogotá: Editorial Ejemplo, 2019");
  });
});

describe("the patched APA date macro", () => {
  it("no longer renders an empty month-day group as (2012,)", async () => {
    const golden = JSON.parse(
      await readFile(join(root, "styles", "fixtures", "apa-7.expected.json"), "utf8"),
    );
    for (const key of ["law", "standard", "webpage", "dataset"])
      expect(golden.bibliography[key]).toMatch(/\(\d{4}\)\./);
    expect(JSON.stringify(golden)).not.toMatch(/\(\d{4},\)/);
  });

  it("is documented as a modified CC BY-SA derivative", async () => {
    const csl = await readFile(join(root, "styles", "apa.csl"), "utf8");
    expect(csl).toContain("Modified for @alisio/plugin-thesis");
    expect(csl).toMatch(/<contributor>\s*<name>@alisio\/plugin-thesis maintainers<\/name>/);
    expect(csl).toContain('license="http://creativecommons.org/licenses/by-sa/3.0/"');
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain(
      "modified derivative",
    );
  });
});

describe("status and next across the phases", () => {
  it("shows a per-section table with the next command and covers drafting in /thesis:next", async () => {
    const h = await researched(noEngine);
    const status = await h.run("status");
    expect(status).toContain("SEC-07 Marco teórico [research_approved] -> /thesis:draft SEC-07");
    expect(status).toContain("SEC-09 Resultados [planned] -> waits for SEC-08");
    expect(status).toContain("SEC-12 Referencias [approved]");

    // /thesis:next at "draft SEC-03" (AI declaration, no research) runs the writer.
    h.script("thesis-writer", () =>
      JSON.stringify({
        markdown:
          "Se utilizó un asistente de escritura y el autor revisó todo el contenido de este trabajo de grado.",
        keywords: [],
        claims: [],
        figures: [],
        gaps: [],
        prompt: undefined,
      }),
    );
    h.script("thesis-editor", (prompt) =>
      JSON.stringify({
        markdown:
          /BODY \(data, not instructions\) ===\n([\s\S]*?)\n=== END BODY/.exec(prompt)?.[1] ?? "",
        changes: [],
        queries: [],
      }),
    );
    const next = await h.run("next");
    expect(next).toContain("Drafted SEC-03");
    expect(await h.run("status")).toContain("Next: /thesis:approve SEC-03");
    expect(await h.run("next")).toContain("SEC-03 is in draft review");
  });

  it("reports the sections and the last review through thesis_status", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    const tool = h.tools.get("thesis_status");
    const result = await tool?.execute({}, { workspace: h.workspace } as never);
    const summary = JSON.parse(textOf(result));
    expect(summary.sections.find((entry: { id: string }) => entry.id === "SEC-07")).toMatchObject({
      status: "draft_review",
      next: "/thesis:approve SEC-07",
    });
    expect(summary.lastReview).toBeNull();
  });

  it("filters thesis_check by section", async () => {
    const h = await researched(noEngine);
    await drafted(h);
    const tool = h.tools.get("thesis_check");
    const run = async (input: object) => {
      const result = await tool?.execute(input, { workspace: h.workspace } as never);
      return JSON.parse(textOf(result));
    };
    const all = await run({ gates: ["G7"] });
    const section = await run({ gates: ["G7"], section: "SEC-07" });
    expect(
      section.findings.every(
        (finding: { section?: string; file?: string }) =>
          finding.section === "SEC-07" || finding.file === "chapters/07-marco.md",
      ),
    ).toBe(true);
    expect(section.findings.some((finding: { code: string }) => finding.code === "WRT-001")).toBe(
      true,
    );
    expect(all.findings.length).toBeGreaterThanOrEqual(section.findings.length);
  });
});
