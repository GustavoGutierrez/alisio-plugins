import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildBlueprint } from "../src/blueprint.js";
import { buildExam, fitDocuments, type PdfPrinter, renderDocuments } from "../src/build.js";
import { familyIds } from "../src/families/index.js";
import { type ExamItem, generateExam } from "../src/generate.js";
import {
  shippedKnowledgeDir,
  shippedLocalesDir,
  shippedThemesDir,
} from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import type { LevelCalibration } from "../src/knowledge/types.js";
import { type Locale, loadLocale } from "../src/locales.js";
import type { ExamSpecLike } from "../src/model.js";
import { loadThemeLayers, type Theme } from "../src/themes.js";
import type { ItemType } from "../src/types.js";
import { cleanup, scratchDir } from "./helpers/harness.js";

const emptyTypes = (): Record<ItemType, number> => ({
  single_choice: 0,
  multiple_choice: 0,
  open: 0,
  practice: 0,
});

const pagesByPt: Record<string, number> = {
  "11pt": 5,
  "10.5pt": 4,
  "10pt": 3,
  "9.5pt": 3,
  "9pt": 2,
};

function syntheticPdf(pages: number): Uint8Array {
  return Buffer.from(`${"/Type /Page ".repeat(pages)}/Count ${pages}`);
}

const fakePrinter: PdfPrinter = async (html) => {
  const pt = /--body-pt: ([0-9.]+pt)/.exec(html)?.[1] ?? "11pt";
  return { pdf: syntheticPdf(pagesByPt[pt] ?? 1), engineVersion: "Chrome/test" };
};

let calibration: LevelCalibration;
let locale: Locale;
let theme: Theme;
let items: ExamItem[];

const spec: ExamSpecLike = {
  title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
  theme: "CONJUNTO DE LOS NÚMEROS RACIONALES (Q)",
  grade: "Séptimo",
  questionCount: 5,
  itemTypes: { ...emptyTypes(), single_choice: 3, practice: 2 },
  durationMinutes: 120,
  instrument: "pencil",
  calculator: false,
  columns: 1,
  introOverride: null,
  schoolYear: 2026,
};

const profile = { institution: "Instituto Cristiano Demo", subject: "Matemáticas" };

beforeAll(async () => {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  const pack = knowledge.packs.find((entry) => entry.id === "basic-math");
  if (!pack) throw new Error("basic-math pack missing");
  calibration = pack.levels.basico;
  const blueprint = buildBlueprint({
    topics: ["basic-math/integers"],
    level: "basico",
    calibration,
    itemTypes: spec.itemTypes,
  });
  items = generateExam({
    blueprint,
    topics: knowledge.topics,
    level: "basico",
    calibration,
    seed: "b01",
  }).items;
  const loaded = await loadLocale(shippedLocalesDir(), "es");
  if (!loaded.locale) throw new Error("locale missing");
  locale = loaded.locale;
  const themes = await loadThemeLayers([{ dir: shippedThemesDir(), layer: "shipped" }]);
  const classic = themes.themes.find((entry) => entry.id === "classic");
  if (!classic) throw new Error("classic theme missing");
  theme = classic;
});

afterEach(cleanup);

const renderInput = () => ({
  spec,
  profile,
  items,
  locale,
  theme,
  paper: "letter" as const,
  columns: 1 as const,
  blueprint: buildBlueprint({
    topics: ["basic-math/integers"],
    level: "basico",
    calibration,
    itemTypes: spec.itemTypes,
  }),
  closing: {},
});

describe("renderDocuments", () => {
  it("renders the four self-contained documents with inlined KaTeX and no network", () => {
    const documents = renderDocuments(renderInput());
    expect(documents.exam).toContain(items[0]?.ref ?? "");
    expect(documents.sheet).toContain("Hoja de respuestas");
    expect(documents.book).toContain("Solucionario");
    expect(documents.rubric).toContain("Rúbrica");
    for (const html of [documents.exam, documents.sheet, documents.book, documents.rubric]) {
      expect(html).toContain("data:font/woff2;base64,");
      expect(html).not.toMatch(/https?:\/\//);
    }
  });
});

describe("fitDocuments", () => {
  it("selects the fewest pages for auto and the most comfortable within a budget", async () => {
    const auto = await fitDocuments({
      htmlForPreset: (p) => `--body-pt: ${p.bodyPt}pt`,
      maxPages: "auto",
      printer: fakePrinter,
    });
    expect(auto.chosen.preset?.id).toBe("minimum");
    expect(auto.engineVersion).toBe("Chrome/test");
    const three = await fitDocuments({
      htmlForPreset: (p) => `--body-pt: ${p.bodyPt}pt`,
      maxPages: 3,
      printer: fakePrinter,
    });
    expect(three.chosen.preset?.id).toBe("compact");
  });

  it("fails explicitly when the budget is unreachable", async () => {
    const result = await fitDocuments({
      htmlForPreset: (p) => `--body-pt: ${p.bodyPt}pt`,
      maxPages: 1,
      printer: fakePrinter,
    });
    expect(result.chosen.failure?.smallestReached).toBe(2);
  });
});

describe("buildExam", () => {
  it("writes the four HTML documents, the layout report and the PDFs", async () => {
    const outDir = await scratchDir();
    const result = await buildExam({
      ...renderInput(),
      executable: "/scratch/p/chrome",
      outDir,
      maxPages: "auto",
      printer: fakePrinter,
    });
    expect(result.layoutReport?.preset).toBe("minimum");
    expect(result.findings).toEqual([]);
    const files = await readdir(outDir);
    expect(files.filter((name) => name.endsWith(".html"))).toHaveLength(4);
    expect(files.filter((name) => name.endsWith(".pdf"))).toHaveLength(4);
    expect(files).toContain("layout-report.json");
    const report = JSON.parse(await readFile(`${outDir}/layout-report.json`, "utf8")) as {
      preset: string;
    };
    expect(report.preset).toBe("minimum");
  });

  it("reports EVL-LAY-001 and writes no PDFs when the page limit is unreachable", async () => {
    const outDir = await scratchDir();
    const result = await buildExam({
      ...renderInput(),
      executable: "/scratch/p/chrome",
      outDir,
      maxPages: 1,
      printer: fakePrinter,
    });
    expect(result.findings.map((finding) => finding.id)).toContain("EVL-LAY-001");
    expect(result.layoutReport).toBeUndefined();
    const files = await readdir(outDir);
    expect(files.filter((name) => name.endsWith(".pdf"))).toHaveLength(0);
  });
});
