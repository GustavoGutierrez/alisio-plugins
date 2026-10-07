import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blueprint } from "./blueprint.js";
import { printHtmlToPdf } from "./chrome/cdp.js";
import type { ExamItem } from "./generate.js";
import { emitDocument } from "./html/emit.js";
import { evaluaMathRenderer, katexCss } from "./katex.js";
import type { CheckFinding } from "./knowledge/report.js";
import { type DensityPreset, densityLadder } from "./layout/presets.js";
import {
  buildLayoutReport,
  choosePreset,
  countPdfPages,
  type FitResult,
  type LayoutReport,
} from "./layout.js";
import type { Locale } from "./locales.js";
import {
  buildAnswerSheetModel,
  buildExamModel,
  buildRubricModel,
  buildSolutionBookModel,
  type ExamSpecLike,
  type ProfileLike,
} from "./model.js";
import type { ClosingSelection } from "./quotes.js";
import type { Theme } from "./themes.js";

/** Builds the four documents and fits the page budget (spec 10.1, 11.3). */

export type PdfPrinter = (html: string) => Promise<{ pdf: Uint8Array; engineVersion: string }>;

export interface RenderInput {
  spec: ExamSpecLike;
  profile: ProfileLike;
  items: readonly ExamItem[];
  locale: Locale;
  theme: Theme;
  paper: "letter" | "a4";
  columns: 1 | 2;
  blueprint: Blueprint;
  closing: ClosingSelection;
}

export interface RenderedDocuments {
  exam: string;
  sheet: string;
  book: string;
  rubric: string;
  findings: CheckFinding[];
}

function defaultDensity(): DensityPreset {
  const preset = densityLadder[0];
  if (!preset) throw new Error("the density ladder is empty");
  return preset;
}

function emit(
  input: RenderInput,
  density: DensityPreset,
  model: Parameters<typeof emitDocument>[0],
): string {
  return emitDocument(model, {
    theme: input.theme,
    density,
    paper: input.paper,
    columns: input.columns,
    math: evaluaMathRenderer,
    extraCss: katexCss(),
  });
}

/** Renders the four documents to self-contained HTML at one density preset. */
export function renderDocuments(input: RenderInput, density = defaultDensity()): RenderedDocuments {
  const exam = buildExamModel({
    spec: input.spec,
    profile: input.profile,
    items: input.items,
    locale: input.locale,
    closing: input.closing,
    density,
  });
  const sheet = buildAnswerSheetModel({
    spec: input.spec,
    profile: input.profile,
    items: input.items,
    locale: input.locale,
    blueprint: input.blueprint,
  });
  const book = buildSolutionBookModel({
    spec: input.spec,
    profile: input.profile,
    items: input.items,
    locale: input.locale,
  });
  const rubric = buildRubricModel({
    spec: input.spec,
    profile: input.profile,
    items: input.items,
    locale: input.locale,
  });
  return {
    exam: emit(input, density, exam.model),
    sheet: emit(input, density, sheet),
    book: emit(input, density, book),
    rubric: emit(input, density, rubric),
    findings: exam.findings,
  };
}

export interface FitInput {
  htmlForPreset: (preset: DensityPreset) => string;
  maxPages: "auto" | number;
  printer: PdfPrinter;
  ladder?: readonly DensityPreset[];
}

export interface FitOutput {
  chosen: FitResult;
  pageCounts: Map<string, number>;
  engineVersion?: string;
}

/** Measures every preset (a linear scan, spec 11.3) and selects the density. */
export async function fitDocuments(input: FitInput): Promise<FitOutput> {
  const ladder = input.ladder ?? densityLadder;
  const pageCounts = new Map<string, number>();
  let engineVersion: string | undefined;
  for (const preset of ladder) {
    const result = await input.printer(input.htmlForPreset(preset));
    engineVersion ??= result.engineVersion;
    pageCounts.set(preset.id, countPdfPages(result.pdf).leafPages);
  }
  return {
    chosen: choosePreset({ pageCounts, maxPages: input.maxPages, ladder }),
    pageCounts,
    ...(engineVersion === undefined ? {} : { engineVersion }),
  };
}

export interface BuildInput extends RenderInput {
  executable: string;
  outDir: string;
  maxPages: "auto" | number;
  timeoutMs?: number;
  /** Test seam: when given, this printer is used instead of launching Chrome. */
  printer?: PdfPrinter;
}

export interface BuildOutput {
  files: string[];
  layoutReport?: LayoutReport;
  findings: CheckFinding[];
  engineVersion?: string;
}

/** Fits the page budget and writes the four documents as HTML, plus PDFs when Chrome is available. */
export async function buildExam(input: BuildInput): Promise<BuildOutput> {
  const findings: CheckFinding[] = [];
  const printer: PdfPrinter =
    input.printer ??
    ((html) =>
      printHtmlToPdf({
        executable: input.executable,
        html,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      }).then((result) => ({ pdf: result.pdf, engineVersion: result.engineVersion })));

  const fit = await fitDocuments({
    htmlForPreset: (preset) => renderDocuments(input, preset).exam,
    maxPages: input.maxPages,
    printer,
  });
  if (fit.chosen.failure) {
    findings.push({
      id: "EVL-LAY-001",
      severity: "error",
      subject: "layout",
      message: `page limit unreachable; the smallest count reached was ${fit.chosen.failure.smallestReached}`,
    });
  }

  const preset = fit.chosen.preset ?? defaultDensity();
  const documents = renderDocuments(input, preset);
  findings.push(...documents.findings);

  await mkdir(input.outDir, { recursive: true });
  const files: string[] = [];
  const write = async (name: string, content: string | Uint8Array): Promise<void> => {
    const path = join(input.outDir, name);
    await writeFile(path, content);
    files.push(path);
  };
  await write("01_examen_estudiante.html", documents.exam);
  await write("02_hoja_respuestas.html", documents.sheet);
  await write("03_solucionario_completo.html", documents.book);
  await write("04_rubrica_calificacion.html", documents.rubric);

  let layoutReport: LayoutReport | undefined;
  if (fit.chosen.preset !== undefined) {
    layoutReport = buildLayoutReport({
      chosen: fit.chosen,
      pageCounts: fit.pageCounts,
      engineVersion: fit.engineVersion ?? "unknown",
      maxPages: input.maxPages,
    });
    if (layoutReport)
      await write("layout-report.json", `${JSON.stringify(layoutReport, null, 2)}\n`);
    for (const [name, html] of [
      ["01_examen_estudiante.pdf", documents.exam],
      ["02_hoja_respuestas.pdf", documents.sheet],
      ["03_solucionario_completo.pdf", documents.book],
      ["04_rubrica_calificacion.pdf", documents.rubric],
    ] as const) {
      const { pdf } = await printer(html);
      await write(name, pdf);
    }
  }
  return {
    files,
    ...(layoutReport === undefined ? {} : { layoutReport }),
    findings,
    ...(fit.engineVersion === undefined ? {} : { engineVersion: fit.engineVersion }),
  };
}
