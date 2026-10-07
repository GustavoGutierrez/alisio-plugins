import type { DensityPreset } from "../layout/presets.js";
import { type Block, escapeHtml, type InlineToken, parseMarkup } from "../markup.js";
import type {
  AnswerSheetModel,
  DocumentModel,
  ExamModel,
  HeaderModel,
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

function renderBlocks(blocks: readonly Block[], math: MathRenderer): string {
  return blocks
    .map((block) => {
      if (block.kind === "paragraph") return `<p>${renderInline(block.inline, math)}</p>`;
      if (block.kind === "display") return `<div class="display">${math(block.value, true)}</div>`;
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
  return `<header class="exam-header${band}">${logo}
  <div class="institution">${escapeHtml(header.institution)}</div>
  <div class="title">${escapeHtml(header.title)}</div>
  <div class="theme">${escapeHtml(header.themeLine)}</div>
</header>`;
}

function renderInfo(model: ExamModel): string {
  const rows = model.info
    .map(
      (row) =>
        `<tr><td class="label">${escapeHtml(row.label)}</td><td>${escapeHtml(row.value)}</td></tr>`,
    )
    .join("");
  return `<table class="info-table"><tbody>${rows}<tr><td class="label">${escapeHtml(model.notaLabel)}</td><td class="nota"></td></tr></tbody></table>`;
}

function renderItem(item: ItemModel, math: MathRenderer): string {
  const options =
    item.options.length === 0
      ? ""
      : `<div class="options">${item.options
          .map(
            (option) =>
              `<span class="option"><span class="key">${escapeHtml(option.key)}.</span>${renderBlocks(parseMarkup(option.markup), math)}</span>`,
          )
          .join("")}</div>`;
  const space =
    item.answerSpaceLines > 0
      ? `<div class="answer-space" style="--answer-lines: ${item.answerSpaceLines}"></div>`
      : "";
  return `<div class="item"><span class="number">${item.number}.</span><span class="ref">${escapeHtml(item.ref)}</span><div class="stem">${renderBlocks(parseMarkup(item.stem), math)}</div>${options}${space}</div>`;
}

function renderExam(model: ExamModel, options: EmitOptions): string {
  const sections = model.sections
    .map((section) => {
      const title =
        section.title === null
          ? ""
          : `<div class="section-title">${escapeHtml(section.title)}</div>`;
      return `${title}${section.items.map((item) => renderItem(item, options.math)).join("")}`;
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
  const rows = model.rows
    .map(
      (row) =>
        `<tr><td>${row.number}</td><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.answer)}</td><td>${row.points}</td></tr>`,
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
  const entries = model.entries
    .map(
      (entry) => `<div class="solution-entry">
  <h2>${entry.number} · ${escapeHtml(entry.ref)}</h2>
  ${renderBlocks(parseMarkup(entry.stem), options.math)}
  <p class="answer">${escapeHtml(entry.answer)}</p>
  <ol>${entry.solution.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
  ${entry.misconceptions.map((item) => `<p class="misconception">${escapeHtml(item.key)} · ${escapeHtml(item.text)} — ${escapeHtml(item.error)}</p>`).join("")}
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
export function emitDocument(model: DocumentModel, options: EmitOptions): string {
  const css = renderCss({
    theme: options.theme,
    density: options.density,
    paper: options.paper,
    columns: options.columns,
  });
  const bodyClass = options.columns === 2 ? "columns-2" : "columns-1";
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
