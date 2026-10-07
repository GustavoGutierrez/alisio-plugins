/**
 * Mini markup tokenizer (spec 5.5): plain text with `$…$` inline math, `$$…$$` display math and
 * table block objects. The renderer tokenizes it itself; text is HTML-escaped at emit time.
 */

import type { FigureSpec } from "./figures/index.js";

export interface TableBlock {
  table: { head: string[]; rows: string[][] };
}

/** A block that embeds a deterministic figure (spec: figures). */
export interface FigureBlock {
  figure: FigureSpec;
}

export type MarkupLine = string | TableBlock | FigureBlock;

export type InlineToken = { kind: "text"; value: string } | { kind: "math"; value: string };

export type Block =
  | { kind: "paragraph"; inline: InlineToken[] }
  | { kind: "display"; value: string }
  | { kind: "table"; head: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: "figure"; spec: FigureSpec };

const inlinePattern = /\$([^$]+)\$/g;
const displayPattern = /^\s*\$\$([\s\S]+?)\$\$\s*$/;

/** Splits a line into text and `$…$` math tokens, preserving order. */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  inlinePattern.lastIndex = 0;
  let match = inlinePattern.exec(text);
  while (match !== null) {
    if (match.index > last) {
      tokens.push({ kind: "text", value: text.slice(last, match.index) });
    }
    const value = match[1];
    if (value !== undefined) tokens.push({ kind: "math", value });
    last = match.index + match[0].length;
    match = inlinePattern.exec(text);
  }
  if (last < text.length) tokens.push({ kind: "text", value: text.slice(last) });
  return tokens;
}

function isTableBlock(line: MarkupLine): line is TableBlock {
  return (
    typeof line !== "string" && "table" in line && Array.isArray((line as TableBlock).table?.head)
  );
}

function isFigureBlock(line: MarkupLine): line is FigureBlock {
  return typeof line !== "string" && typeof (line as FigureBlock).figure?.kind === "string";
}

/** Parses markup lines into blocks: paragraphs, display math, tables and figures. */
export function parseMarkup(lines: readonly MarkupLine[]): Block[] {
  const blocks: Block[] = [];
  for (const line of lines) {
    if (isFigureBlock(line)) {
      blocks.push({ kind: "figure", spec: line.figure });
      continue;
    }
    if (isTableBlock(line)) {
      blocks.push({
        kind: "table",
        head: line.table.head.map((cell) => tokenizeInline(cell)),
        rows: line.table.rows.map((row) => row.map((cell) => tokenizeInline(cell))),
      });
      continue;
    }
    const display = displayPattern.exec(line);
    if (display !== null && display[1] !== undefined) {
      blocks.push({ kind: "display", value: display[1] });
      continue;
    }
    blocks.push({ kind: "paragraph", inline: tokenizeInline(line) });
  }
  return blocks;
}

/** HTML-escapes text so item content can never inject markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
