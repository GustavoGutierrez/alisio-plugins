import { beforeAll, describe, expect, it } from "vitest";
import { buildBlueprint } from "../src/blueprint.js";
import { familyIds } from "../src/families/index.js";
import { type ExamItem, generateExam } from "../src/generate.js";
import { emitDocument } from "../src/html/emit.js";
import {
  shippedKnowledgeDir,
  shippedLocalesDir,
  shippedThemesDir,
} from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import type { LevelCalibration } from "../src/knowledge/types.js";
import { type DensityPreset, presetById } from "../src/layout/presets.js";
import { type Locale, loadLocale } from "../src/locales.js";
import { escapeHtml } from "../src/markup.js";
import {
  buildAnswerSheetModel,
  buildExamModel,
  buildIntro,
  buildRubricModel,
  buildSolutionBookModel,
  type ExamSpecLike,
} from "../src/model.js";
import { loadThemeLayers, type Theme } from "../src/themes.js";
import type { ItemType } from "../src/types.js";

const emptyTypes = (): Record<ItemType, number> => ({
  single_choice: 0,
  multiple_choice: 0,
  open: 0,
  practice: 0,
});

const density = (id: string): DensityPreset => {
  const preset = presetById(id);
  if (!preset) throw new Error(`missing preset ${id}`);
  return preset;
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
    seed: "e01",
  }).items;
  const loadedLocale = await loadLocale(shippedLocalesDir(), "es");
  if (!loadedLocale.locale) throw new Error("es locale missing");
  locale = loadedLocale.locale;
  const themes = await loadThemeLayers([{ dir: shippedThemesDir(), layer: "shipped" }]);
  const classic = themes.themes.find((entry) => entry.id === "classic");
  if (!classic) throw new Error("classic theme missing");
  theme = classic;
});

describe("buildIntro", () => {
  it("drops the procedure clause without open/practice and adds it with them", () => {
    const without = buildIntro(locale, {
      ...spec,
      itemTypes: { ...emptyTypes(), single_choice: 5 },
    });
    expect(without.text).not.toContain("procedimiento");
    expect(without.text).toContain("selección");
    const withProcedure = buildIntro(locale, spec);
    expect(withProcedure.text).toContain("procedimiento");
    expect(withProcedure.finding).toBeUndefined();
  });

  it("adds the calculator clause only when the calculator is allowed", () => {
    expect(buildIntro(locale, spec).text).not.toContain("calculadora");
    expect(buildIntro(locale, { ...spec, calculator: true }).text).toContain("calculadora");
  });

  it("warns when the intro passes 70 words", () => {
    const long = Array.from({ length: 75 }, () => "palabra").join(" ");
    const result = buildIntro(locale, { ...spec, introOverride: long });
    expect(result.finding?.id).toBe("EVL-DOC-004");
    expect(result.finding?.severity).toBe("warning");
  });
});

describe("document models", () => {
  it("builds the exam model with header, info, sections and consecutive numbering", () => {
    const { model, findings } = buildExamModel({
      spec,
      profile,
      items,
      locale,
      closing: {},
      density: density("comfortable"),
    });
    expect(findings).toEqual([]);
    expect(model.header.institution).toBe("INSTITUTO CRISTIANO DEMO");
    expect(model.header.themeLine).toBe("TEMA: CONJUNTO DE LOS NÚMEROS RACIONALES (Q)");
    expect(model.info[0]).toEqual({ label: "Año lectivo", value: "2026" });
    expect(model.sections).toHaveLength(2);
    expect(model.sections[0]?.title).toBe("Selección única");
    const numbers = model.sections.flatMap((section) => section.items.map((item) => item.number));
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect(model.sections[1]?.items[0]?.answerSpaceLines).toBeGreaterThanOrEqual(6);
    expect(model.closing).toBeNull();
  });

  it("builds the answer sheet with a by-ref index and the total points", () => {
    const sheet = buildAnswerSheetModel({
      spec,
      profile,
      items,
      locale,
      blueprint: buildBlueprint({
        topics: ["basic-math/integers"],
        level: "basico",
        calibration,
        itemTypes: spec.itemTypes,
      }),
    });
    expect(sheet.rows).toHaveLength(5);
    expect(sheet.totalPoints).toBe(7);
    const refs = sheet.indexByRef.map((entry) => entry.ref);
    expect(refs).toEqual([...refs].sort());
  });

  it("builds the solution book with named misconceptions and the rubric for graded items", () => {
    const book = buildSolutionBookModel({ spec, profile, items, locale });
    expect(book.entries).toHaveLength(5);
    expect(book.entries[0]?.misconceptions.length).toBeGreaterThan(0);
    expect(book.entries[0]?.misconceptions[0]?.error).not.toBe("none");
    const rubric = buildRubricModel({ spec, profile, items, locale });
    expect(rubric.entries).toHaveLength(2);
    expect(rubric.entries[0]?.criteria.map((criterion) => criterion.label)).toContain(
      "Procedimiento completo",
    );
  });
});

describe("emitDocument", () => {
  const math = (tex: string, display: boolean) =>
    `<span class="math${display ? " display" : ""}">${escapeHtml(tex)}</span>`;

  it("emits a self-contained HTML with the theme and density tokens and no network reference", () => {
    const { model } = buildExamModel({
      spec,
      profile,
      items,
      locale,
      closing: {
        entry: {
          id: "x",
          kind: "quote",
          text: "La matemática es bella.",
          source: "s",
          tags: [],
          language: "es",
        },
      },
      density: density("regular"),
    });
    const html = emitDocument(model, {
      theme,
      density: density("regular"),
      paper: "letter",
      columns: 1,
      math,
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--body-pt: 10.5pt");
    expect(html).toContain("--accent: #1a1a1a");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("@import");
    expect(html).toContain(items[0]?.ref ?? "");
    expect(html).toContain("La matemática es bella.");
  });

  it("escapes item and intro text so content cannot inject markup", () => {
    const { model } = buildExamModel({
      spec: { ...spec, introOverride: '<script>alert("x")</script>' },
      profile,
      items,
      locale,
      closing: {},
      density: density("compact"),
    });
    const html = emitDocument(model, {
      theme,
      density: density("compact"),
      paper: "a4",
      columns: 2,
      math,
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("size: A4");
    expect(html).toContain("columns-2");
  });
});
