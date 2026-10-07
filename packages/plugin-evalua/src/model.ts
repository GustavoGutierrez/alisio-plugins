import type { Blueprint } from "./blueprint.js";
import type { ExamItem } from "./generate.js";
import type { CheckFinding } from "./knowledge/report.js";
import type { DensityPreset } from "./layout/presets.js";
import type { Locale } from "./locales.js";
import type { MarkupLine } from "./markup.js";
import type { ClosingSelection } from "./quotes.js";
import { type ItemType, itemTypes, type NumberingScheme } from "./types.js";

export interface ExamSpecLike {
  title: string;
  theme: string;
  grade: string;
  questionCount: number;
  itemTypes: Record<ItemType, number>;
  durationMinutes: number;
  instrument: string;
  calculator: boolean;
  columns: 1 | 2;
  numbering?: NumberingScheme;
  introOverride: string | null;
  schoolYear: number;
}

export interface ProfileLike {
  institution: string;
  subject: string;
  teacherName?: string;
  logo?: string;
}

export interface HeaderModel {
  institution: string;
  title: string;
  theme: string;
  /** The printed theme line, e.g. `TEMA: CONJUNTO DE LOS NÚMEROS RACIONALES (Q)`. */
  themeLine: string;
  logo?: string;
}

export interface InfoRow {
  label: string;
  value: string;
  /**
   * When true the row owns its line and its value spans the whole row width instead of pairing
   * with the next row, so a long value (the teacher or student name) fits on one line.
   */
  full?: boolean;
  /** When true the value never wraps, so a fill-in mask stays on one line. */
  nowrap?: boolean;
}

export interface ItemModel {
  number: number;
  /** The number or letter shown on the sheet, per the numbering scheme (spec 9.1). */
  label: string;
  ref: string;
  type: ItemType;
  stem: MarkupLine[];
  options: { key: string; markup: MarkupLine[] }[];
  answerSpaceLines: number;
}

export interface SectionModel {
  /** 1-based section index, shown before the title (spec 9.1). */
  number: number;
  title: string | null;
  items: ItemModel[];
}

export interface ClosingModel {
  text: string;
  author?: string;
  reference?: string;
}

export interface ExamModel {
  kind: "exam";
  header: HeaderModel;
  info: InfoRow[];
  notaLabel: string;
  intro: string;
  sections: SectionModel[];
  closing: ClosingModel | null;
}

export interface AnswerSheetRow {
  number: number;
  ref: string;
  type: ItemType;
  typeLabel: string;
  answer: string;
  points: number;
}

export interface AnswerSheetModel {
  kind: "sheet";
  title: string;
  header: HeaderModel;
  rows: AnswerSheetRow[];
  totalPoints: number;
  indexByRef: { ref: string; number: number }[];
  blueprintSummary: string[];
}

export interface SolutionEntry {
  number: number;
  ref: string;
  stem: MarkupLine[];
  answer: string;
  solution: string[];
  misconceptions: { key: string; text: string; error: string }[];
  needsTeacherReview: boolean;
}

export interface SolutionBookModel {
  kind: "book";
  title: string;
  header: HeaderModel;
  entries: SolutionEntry[];
}

export interface RubricCriterion {
  label: string;
  points: number;
}

export interface RubricEntry {
  number: number;
  ref: string;
  criteria: RubricCriterion[];
}

export interface RubricModel {
  kind: "rubric";
  title: string;
  header: HeaderModel;
  entries: RubricEntry[];
}

export type DocumentModel = ExamModel | AnswerSheetModel | SolutionBookModel | RubricModel;

export interface IntroResult {
  text: string;
  words: number;
  finding?: CheckFinding;
}

const MAX_INTRO_WORDS = 70;

function formatDuration(locale: Locale, minutes: number): string {
  const asHours = minutes >= 60 && minutes % 60 === 0;
  const n = asHours ? minutes / 60 : minutes;
  const { duration } = locale;
  const plural = asHours ? duration.hours : duration.minutes;
  const singular = asHours ? duration.hour : duration.minute;
  return (n === 1 ? (singular ?? plural) : plural).replace("{n}", String(n));
}

/** Builds the intro paragraph from the locale template, dropping clauses (spec 9.2). */
export function buildIntro(locale: Locale, spec: ExamSpecLike): IntroResult {
  if (spec.introOverride !== null && spec.introOverride.trim() !== "") {
    const words = spec.introOverride.trim().split(/\s+/).length;
    return withWordCheck(spec.introOverride.trim(), words);
  }
  const hasProcedure = (spec.itemTypes.open ?? 0) + (spec.itemTypes.practice ?? 0) > 0;
  const hasChoice = (spec.itemTypes.single_choice ?? 0) + (spec.itemTypes.multiple_choice ?? 0) > 0;
  const instrument = locale.instrument[spec.instrument] ?? spec.instrument;
  const base = locale.intro.base
    .replace("{n}", String(spec.questionCount))
    .replace("{duration}", formatDuration(locale, spec.durationMinutes))
    .replace("{instrument}", instrument);
  const parts = [base];
  if (hasProcedure) parts.push(locale.intro.procedure);
  if (hasChoice) parts.push(locale.intro.selection);
  parts.push(locale.intro.clarity);
  if (spec.calculator) parts.push(locale.intro.calculator);
  const text = parts.join(" ");
  return withWordCheck(text, text.split(/\s+/).length);
}

function withWordCheck(text: string, words: number): IntroResult {
  if (words > MAX_INTRO_WORDS) {
    return {
      text,
      words,
      finding: {
        id: "EVL-DOC-004",
        severity: "warning",
        subject: "intro",
        message: `intro paragraph has ${words} words, more than ${MAX_INTRO_WORDS}`,
      },
    };
  }
  return { text, words };
}

function header(spec: ExamSpecLike, profile: ProfileLike, locale: Locale): HeaderModel {
  return {
    institution: profile.institution.toLocaleUpperCase("es"),
    title: spec.title,
    theme: spec.theme,
    themeLine: `${locale.labels.themeLabel ?? "TEMA"}: ${spec.theme}`,
    ...(profile.logo === undefined ? {} : { logo: profile.logo }),
  };
}

/** The fill-in date mask: three blanks on one line, so the whole mask fits inside its cell. */
const DATE_MASK = "____ / ____ / ____";

function answerSpaceLines(item: ExamItem, density: DensityPreset): number {
  const seconds = item.estimatedSeconds;
  if (item.type === "practice") {
    return Math.max(6, Math.round((seconds / 15) * density.practiceSpace));
  }
  if (item.type === "open") {
    return Math.max(3, Math.round((seconds / 20) * density.practiceSpace));
  }
  return 0;
}

/** a, b, ... z, aa, ab ... for the `letters` numbering scheme. */
function letterLabel(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function itemModel(
  item: ExamItem,
  number: number,
  label: string,
  density: DensityPreset,
): ItemModel {
  return {
    number,
    label,
    ref: item.ref,
    type: item.type,
    stem: item.stem,
    options: item.options.map((option) => ({ key: option.key, markup: [option.display] })),
    answerSpaceLines: answerSpaceLines(item, density),
  };
}

/** The student exam model (spec 9.1): header, info table, intro, sections, closing. */
export function buildExamModel(input: {
  spec: ExamSpecLike;
  profile: ProfileLike;
  items: readonly ExamItem[];
  locale: Locale;
  closing: ClosingSelection;
  density: DensityPreset;
}): { model: ExamModel; findings: CheckFinding[] } {
  const { spec, profile, items, locale, density } = input;
  const findings: CheckFinding[] = [];
  const intro = buildIntro(locale, spec);
  if (intro.finding) findings.push(intro.finding);

  const presentTypes = itemTypes.filter((type) => items.some((item) => item.type === type));
  const grouped = presentTypes.length > 1;
  const numbering = spec.numbering ?? "letters";
  const sections: SectionModel[] = [];
  let number = 1;
  for (const [index, type] of presentTypes.entries()) {
    const sectionItems = items
      .filter((item) => item.type === type)
      .map((item, position) => {
        const global = number++;
        const label =
          numbering === "section"
            ? `${index + 1}.${position + 1}`
            : numbering === "letters"
              ? letterLabel(position)
              : String(global);
        return itemModel(item, global, label, density);
      });
    sections.push({
      number: index + 1,
      title: grouped ? (locale.sections[type] ?? type) : null,
      items: sectionItems,
    });
  }

  const info: InfoRow[] = [
    { label: locale.labels.year ?? "Año lectivo", value: String(spec.schoolYear) },
    { label: locale.labels.subject ?? "Asignatura", value: profile.subject },
    { label: locale.labels.teacher ?? "Docente", value: profile.teacherName ?? "", full: true },
    { label: locale.labels.period ?? "Periodo", value: "" },
    { label: locale.labels.grade ?? "Grado", value: spec.grade },
    { label: locale.labels.student ?? "Estudiante", value: "", full: true },
    { label: locale.labels.date ?? "Fecha", value: DATE_MASK, full: true, nowrap: true },
  ];

  const closing: ClosingModel | null = input.closing.entry
    ? {
        text: input.closing.entry.text,
        ...(input.closing.entry.author === undefined ? {} : { author: input.closing.entry.author }),
        ...(input.closing.entry.reference === undefined
          ? {}
          : { reference: input.closing.entry.reference }),
      }
    : input.closing.teacherText
      ? { text: input.closing.teacherText }
      : null;

  return {
    model: {
      kind: "exam",
      header: header(spec, profile, locale),
      info,
      notaLabel: locale.labels.nota ?? "Nota",
      intro: intro.text,
      sections,
      closing,
    },
    findings,
  };
}

/** The teacher answer sheet: number -> ref -> answer -> points, plus a by-ref index (spec 8.5). */
export function buildAnswerSheetModel(input: {
  spec: ExamSpecLike;
  profile: ProfileLike;
  items: readonly ExamItem[];
  locale: Locale;
  blueprint: Blueprint;
}): AnswerSheetModel {
  const { spec, profile, items, locale, blueprint } = input;
  const rows = items.map((item, index) => ({
    number: index + 1,
    ref: item.ref,
    type: item.type,
    typeLabel: locale.sections[item.type] ?? item.type,
    answer: item.answer.display,
    points: item.points,
  }));
  return {
    kind: "sheet",
    title: locale.labels.answerSheet ?? "Hoja de respuestas",
    header: header(spec, profile, locale),
    rows,
    totalPoints: items.reduce((acc, item) => acc + item.points, 0),
    indexByRef: rows
      .map((row) => ({ ref: row.ref, number: row.number }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    blueprintSummary: blueprint.cells.map(
      (cell) => `${cell.topic} · ${cell.cognitive} · ${cell.type}: ${cell.count}`,
    ),
  };
}

/** The full solution book: statement, answer, steps and named misconceptions (spec 9.5). */
export function buildSolutionBookModel(input: {
  spec: ExamSpecLike;
  profile: ProfileLike;
  items: readonly ExamItem[];
  locale: Locale;
}): SolutionBookModel {
  const { spec, profile, items, locale } = input;
  return {
    kind: "book",
    title: locale.labels.solutionBook ?? "Solucionario",
    header: header(spec, profile, locale),
    entries: items.map((item, index) => ({
      number: index + 1,
      ref: item.ref,
      stem: item.stem,
      answer: item.answer.display,
      solution: item.solution,
      misconceptions: item.options
        .filter((option) => option.error !== "none")
        .map((option) => ({ key: option.key, text: option.display, error: option.error })),
      needsTeacherReview: item.check.kind === "none",
    })),
  };
}

/** The grading rubric for `open`/`practice` items (spec 9.5). */
export function buildRubricModel(input: {
  spec: ExamSpecLike;
  profile: ProfileLike;
  items: readonly ExamItem[];
  locale: Locale;
}): RubricModel {
  const { spec, profile, items, locale } = input;
  const graded = items
    .map((item, index) => ({ item, number: index + 1 }))
    .filter(({ item }) => item.type === "open" || item.type === "practice");
  return {
    kind: "rubric",
    title: locale.labels.rubric ?? "Rúbrica",
    header: header(spec, profile, locale),
    entries: graded.map(({ item, number }) => ({
      number,
      ref: item.ref,
      criteria: [
        { label: locale.rubric.setup ?? "Planteamiento", points: 1 },
        { label: locale.rubric.procedure ?? "Procedimiento", points: 1 },
        { label: locale.rubric.result ?? "Resultado", points: 1 },
        ...(item.type === "practice"
          ? [{ label: locale.rubric.units ?? "Unidades", points: 1 }]
          : []),
      ],
    })),
  };
}
