import { CardsmithError } from "./errors.js";
import type { LocalizedLabel } from "./palettes.js";

/** Font identity handed to the renderer and the text measurer. */
export interface ResolvedFont {
  alias: string;
  family: string;
  weight: number;
}

export interface FontRole {
  family: string;
  file: string;
  weight: number;
  alias: string;
}

export type FontPairRole = "display" | "body" | "bodyStrong";

export interface FontPairFamily {
  files: Record<string, string>;
}

/**
 * Font pair resource. `families` covers exactly the (family, weight) combinations used by the
 * three roles; `alias` is the name the renderer registers with `GlobalFonts.registerFromPath`.
 * At most two families and three distinct weights per pair.
 */
export interface FontPair {
  id: string;
  version: number;
  label: LocalizedLabel;
  families: Record<string, FontPairFamily>;
  roles: Record<FontPairRole, FontRole>;
  cssFontAlias: string;
}

export const FONT_PAIR_ROLES: readonly FontPairRole[] = ["display", "body", "bodyStrong"];

export function resolveRole(pair: FontPair, role: FontPairRole): ResolvedFont {
  const entry = pair.roles[role];
  if (entry === undefined) {
    throw new CardsmithError("INVALID_SPEC", `Font pair "${pair.id}" has no "${role}" role`, {
      fontPairId: pair.id,
      role,
    });
  }
  return { alias: entry.alias, family: entry.family, weight: entry.weight };
}

export interface TextMeasure {
  width: number;
  ascent: number;
  descent: number;
}

/** Measurement port; the renderer injects a real implementation. */
export interface TextMeasurer {
  measure(text: string, font: ResolvedFont, sizePx: number): TextMeasure;
}

export interface FitRequest {
  text: string;
  font: ResolvedFont;
  maxWidth: number;
  maxHeight: number;
  maxSize: number;
  minSize: number;
  maxLines: number;
  lineHeightRatio?: number;
  breakPolicy?: "word" | "word-then-char";
}

export interface FitResult {
  lines: string[];
  sizePx: number;
  lineHeight: number;
  width: number;
  height: number;
  overflow: boolean;
}

export const DEFAULT_LINE_HEIGHT_RATIO = 1.25;

interface Layout {
  lines: string[];
  width: number;
  height: number;
  overflow: boolean;
}

/**
 * Fit text into a box by word wrapping and binary-searching an integer font size.
 *
 * Guarantees:
 * - explicit `\n` is always a hard break; runs of other whitespace normalize to one separator;
 * - characters are never truncated: when even `minSize` overflows (width, height or `maxLines`),
 *   the result has `overflow: true`, `sizePx === minSize` and the complete text;
 * - `word-then-char` breaks a single over-wide word by code points as a last resort.
 */
export function fitText(request: FitRequest, measurer: TextMeasurer): FitResult {
  const maxSize = Math.round(request.maxSize);
  const minSize = Math.round(request.minSize);
  if (!Number.isFinite(request.maxWidth) || request.maxWidth <= 0) {
    throw new CardsmithError("INVALID_SPEC", "fitText maxWidth must be a positive number", {
      maxWidth: request.maxWidth,
    });
  }
  if (!Number.isFinite(request.maxHeight) || request.maxHeight <= 0) {
    throw new CardsmithError("INVALID_SPEC", "fitText maxHeight must be a positive number", {
      maxHeight: request.maxHeight,
    });
  }
  if (maxSize < 1 || minSize < 1 || minSize > maxSize) {
    throw new CardsmithError("INVALID_SPEC", "fitText size range is invalid", {
      minSize: request.minSize,
      maxSize: request.maxSize,
    });
  }
  if (!Number.isInteger(request.maxLines) || request.maxLines < 1) {
    throw new CardsmithError("INVALID_SPEC", "fitText maxLines must be a positive integer", {
      maxLines: request.maxLines,
    });
  }
  const ratio = request.lineHeightRatio ?? DEFAULT_LINE_HEIGHT_RATIO;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new CardsmithError("INVALID_SPEC", "fitText lineHeightRatio must be positive", {
      lineHeightRatio: request.lineHeightRatio,
    });
  }

  const layoutAt = (sizePx: number): Layout => layoutText(request, sizePx, ratio, measurer);

  let bestSize: number | undefined;
  let bestLayout: Layout | undefined;
  let low = minSize;
  let high = maxSize;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const layout = layoutAt(middle);
    if (layout.overflow) {
      high = middle - 1;
    } else {
      bestSize = middle;
      bestLayout = layout;
      low = middle + 1;
    }
  }

  const sizePx = bestSize ?? minSize;
  const chosen = bestLayout ?? layoutAt(minSize);
  return {
    lines: chosen.lines,
    sizePx,
    lineHeight: sizePx * ratio,
    width: chosen.width,
    height: chosen.height,
    overflow: bestSize === undefined,
  };
}

function layoutText(
  request: FitRequest,
  sizePx: number,
  ratio: number,
  measurer: TextMeasurer,
): Layout {
  const fits = (text: string): boolean =>
    measurer.measure(text, request.font, sizePx).width <= request.maxWidth;
  const breakLongWord = (word: string): string[] => {
    const pieces: string[] = [];
    let current = "";
    for (const character of word) {
      const candidate = current + character;
      if (current === "" || fits(candidate)) {
        current = candidate;
      } else {
        pieces.push(current);
        current = character;
      }
    }
    if (current !== "") pieces.push(current);
    return pieces.length > 0 ? pieces : [word];
  };
  const allowCharBreaks = (request.breakPolicy ?? "word") === "word-then-char";

  const startLine = (word: string, lines: string[]): string => {
    if (fits(word) || !allowCharBreaks) return word;
    const pieces = breakLongWord(word);
    for (let index = 0; index < pieces.length - 1; index += 1) {
      lines.push(pieces[index] ?? "");
    }
    return pieces[pieces.length - 1] ?? word;
  };

  const lines: string[] = [];
  for (const paragraph of request.text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (current === "") {
        current = startLine(word, lines);
      } else if (fits(`${current} ${word}`)) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = startLine(word, lines);
      }
    }
    lines.push(current);
  }

  let width = 0;
  for (const line of lines) {
    const measured = measurer.measure(line, request.font, sizePx).width;
    if (measured > width) width = measured;
  }
  const height = lines.length * sizePx * ratio;
  return {
    lines,
    width,
    height,
    overflow:
      width > request.maxWidth || height > request.maxHeight || lines.length > request.maxLines,
  };
}
