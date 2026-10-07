import { figureSvg } from "../figures/index.js";
import type { DensityPreset } from "../layout/presets.js";
import type { Locale } from "../locales.js";
import { type Block, escapeHtml, type InlineToken, parseMarkup } from "../markup.js";
import type {
  AnswerSheetModel,
  DocumentModel,
  ExamModel,
  HeaderModel,
  InfoRow,
  ItemModel,
  RubricModel,
  SolutionBookModel,
} from "../model.js";
import type { Theme } from "../themes.js";
import { renderCss } from "./css.js";

/** Renders one formula to HTML; the real implementation is the vendored KaTeX (spec 10.2). */
export type MathRenderer = (tex: string, display: boolean) => string;

export interface EmitOptions {
  theme: Theme;
  density: DensityPreset;
  paper: "letter" | "a4";
  columns: 1 | 2;
  math: MathRenderer;
  /** Extra CSS appended after the theme stylesheet (e.g. the inlined KaTeX CSS). */
  extraCss?: string;
}

function renderInline(tokens: readonly InlineToken[], math: MathRenderer): string {
  return tokens
    .map((token) => (token.kind === "text" ? escapeHtml(token.value) : math(token.value, false)))
    .join("");
}

/** Hands out one palette slot per figure, so a document spreads the fills instead of repeating them. */
type ToneCursor = () => number;

function toneCursor(): ToneCursor {
  let index = 0;
  return () => index++;
}

function renderBlocks(blocks: readonly Block[], math: MathRenderer, tone: ToneCursor): string {
  return blocks
    .map((block) => {
      if (block.kind === "paragraph") return `<p>${renderInline(block.inline, math)}</p>`;
      if (block.kind === "display") return `<div class="display">${math(block.value, true)}</div>`;
      if (block.kind === "figure") {
        return `<figure class="figure">${figureSvg(block.spec, tone())}</figure>`;
      }
      const head = block.head.map((cell) => `<th>${renderInline(cell, math)}</th>`).join("");
      const rows = block.rows
        .map(
          (row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, math)}</td>`).join("")}</tr>`,
        )
        .join("");
      return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("");
}

function renderHeader(header: HeaderModel, theme: Theme): string {
  const band = theme.tokens.headerStyle === "band" ? " band" : "";
  const logo =
    header.logo === undefined ? "" : `<img class="logo" src="${escapeHtml(header.logo)}" alt="">`;
  return `<header class="exam-header${band}">
  <div class="header-top">${logo}
    <div class="header-text">
      <div class="institution">${escapeHtml(header.institution)}</div>
      <div class="title">${escapeHtml(header.title)}</div>
      <div class="theme">${escapeHtml(header.themeLine)}</div>
    </div>
  </div>
</header>`;
}

function renderInfo(model: ExamModel): string {
  // Rows that own their line break the pairing; the rest pack two label/value pairs per line.
  const lines: InfoRow[][] = [];
  let pending: InfoRow[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      lines.push(pending);
      pending = [];
    }
  };
  for (const row of model.info) {
    if (row.full === true) {
      flush();
      lines.push([row]);
      continue;
    }
    pending.push(row);
    if (pending.length === 2) flush();
  }
  flush();

  const rows = lines
    .map((line, index) => {
      const [first] = line;
      let cells: string;
      if (line.length === 1 && first !== undefined && first.full === true) {
        const classes = first.nowrap === true ? "value nowrap" : "value";
        cells = `<td class="label">${escapeHtml(first.label)}</td><td class="${classes}" colspan="3">${escapeHtml(first.value)}</td>`;
      } else {
        cells = line
          .map(
            (row) =>
              `<td class="label">${escapeHtml(row.label)}</td><td class="value">${escapeHtml(row.value)}</td>`,
          )
          .join("");
        if (line.length === 1) cells += `<td class="label"></td><td class="value"></td>`;
      }
      const nota =
        index === 0
          ? `<td class="nota" rowspan="${lines.length}"><span class="nota-label">${escapeHtml(model.notaLabel)}</span><span class="nota-box"></span></td>`
          : "";
      return `<tr>${cells}${nota}</tr>`;
    })
    .join("");
  return `<div class="info-box"><table class="info-table"><tbody>${rows}</tbody></table></div>`;
}

function renderItem(item: ItemModel, math: MathRenderer, tone: ToneCursor): string {
  const options =
    item.options.length === 0
      ? ""
      : `<div class="options">${item.options
          .map(
            (option) =>
              `<span class="option"><span class="key">${escapeHtml(option.key)}.</span>${renderBlocks(parseMarkup(option.markup), math, tone)}</span>`,
          )
          .join("")}</div>`;
  const space =
    item.answerSpaceLines > 0
      ? `<div class="answer-space" style="--answer-lines: ${item.answerSpaceLines}"></div>`
      : "";
  return `<div class="item"><span class="number">${escapeHtml(item.label)}</span><span class="ref">${escapeHtml(item.ref)}</span><div class="stem">${renderBlocks(parseMarkup(item.stem), math, tone)}</div>${options}${space}</div>`;
}

function renderExam(model: ExamModel, options: EmitOptions): string {
  const tone = toneCursor();
  const sections = model.sections
    .map((section) => {
      const title =
        section.title === null
          ? ""
          : `<div class="section-title">${section.number}. ${escapeHtml(section.title)}</div>`;
      return `${title}${section.items.map((item) => renderItem(item, options.math, tone)).join("")}`;
    })
    .join("");
  const closing =
    model.closing === null
      ? ""
      : `<div class="closing">${escapeHtml(model.closing.text)}${
          model.closing.author === undefined
            ? ""
            : `<span class="author">${escapeHtml(model.closing.author)}</span>`
        }</div>`;
  return `${renderHeader(model.header, options.theme)}
${renderInfo(model)}
<p class="intro">${escapeHtml(model.intro)}</p>
<div class="questions">${sections}</div>
${closing}`;
}

function renderSheet(model: AnswerSheetModel, options: EmitOptions): string {
  const tone = toneCursor();
  const rows = model.rows
    .map(
      (row) =>
        `<tr><td>${row.number}</td><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(row.typeLabel)}</td><td>${renderBlocks(parseMarkup([row.answer]), options.math, tone)}</td><td>${row.points}</td></tr>`,
    )
    .join("");
  const index = model.indexByRef
    .map((entry) => `<tr><td>${escapeHtml(entry.ref)}</td><td>${entry.number}</td></tr>`)
    .join("");
  return `<h1>${escapeHtml(model.title)}</h1>
${renderHeader(model.header, options.theme)}
<table class="sheet-table"><thead><tr><th>#</th><th>Ref.</th><th>Tipo</th><th>Respuesta</th><th>Puntos</th></tr></thead><tbody>${rows}</tbody></table>
<p>Total: ${model.totalPoints}</p>
<table class="sheet-table"><tbody>${index}</tbody></table>
<ul>${model.blueprintSummary.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function renderBook(model: SolutionBookModel, options: EmitOptions): string {
  const tone = toneCursor();
  const entries = model.entries
    .map(
      (entry) => `<div class="solution-entry">
  <h2>${entry.number} · ${escapeHtml(entry.ref)}</h2>
  ${renderBlocks(parseMarkup(entry.stem), options.math, tone)}
  <div class="answer">${renderBlocks(parseMarkup([entry.answer]), options.math, tone)}</div>
  <ol>${entry.solution.map((step) => `<li>${renderBlocks(parseMarkup([step]), options.math, tone)}</li>`).join("")}</ol>
  ${entry.misconceptions.map((item) => `<p class="misconception">${escapeHtml(item.key)} · ${renderBlocks(parseMarkup([item.text]), options.math, tone)} — ${escapeHtml(item.error)}</p>`).join("")}
</div>`,
    )
    .join("");
  return `<h1>${escapeHtml(model.title)}</h1>${entries}`;
}

function renderRubric(model: RubricModel): string {
  const entries = model.entries
    .map(
      (entry) => `<div class="solution-entry">
  <h2>${entry.number} · ${escapeHtml(entry.ref)}</h2>
  <table class="grid"><tbody>${entry.criteria
    .map(
      (criterion) => `<tr><td>${escapeHtml(criterion.label)}</td><td>${criterion.points}</td></tr>`,
    )
    .join("")}</tbody></table>
</div>`,
    )
    .join("");
  return `<h1>${escapeHtml(model.title)}</h1>${entries}`;
}

function renderBody(model: DocumentModel, options: EmitOptions): string {
  if (model.kind === "exam") return renderExam(model, options);
  if (model.kind === "sheet") return renderSheet(model, options);
  if (model.kind === "book") return renderBook(model, options);
  return renderRubric(model);
}

/** Emits a full, self-contained HTML document (no network references). */
/**
 * The Chrome print footer that numbers the pages (spec 9.1). Chrome replaces the `pageNumber` and
 * `totalPages` classes at print time; the wording comes from the locale.
 */
export function pageFooterHtml(locale: Locale): string {
  const template = locale.labels.pageOf ?? "Página {page} de {total}";
  const text = escapeHtml(template)
    .replace("{page}", '<span class="pageNumber"></span>')
    .replace("{total}", '<span class="totalPages"></span>');
  return `<div style="width:100%;padding:0 4mm;font-family:Arial,sans-serif;font-size:8pt;color:#333333;text-align:right;">${text}</div>`;
}

export function emitDocument(model: DocumentModel, options: EmitOptions): string {
  const css = renderCss({
    theme: options.theme,
    density: options.density,
    paper: options.paper,
    columns: options.columns,
  });
  const bodyClass = [
    options.columns === 2 ? "columns-2" : "columns-1",
    // A vertical rule between the two columns only helps when the items carry answer options; a
    // plain list of exercises to solve reads better without it.
    model.kind === "exam" &&
    model.sections.some((section) => section.items.some((item) => item.options.length > 0))
      ? "has-options"
      : "",
  ]
    .filter((entry) => entry !== "")
    .join(" ");
  const title = model.kind === "exam" ? model.header.title : model.title;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${css}
${options.extraCss ?? ""}
</style>
</head>
<body class="${bodyClass}">
${renderBody(model, options)}
</body>
</html>
`;
}
