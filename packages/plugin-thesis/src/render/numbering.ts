import type { Section } from "./model.js";

/**
 * Format-neutral static numbering (spec 10.0, 16.4). Figures, tables and labeled equations are
 * numbered here, by document order, instead of by an engine's counters: engine counters evaluate
 * chapter prefixes at the *reference* site and misnumber forward references. Every adapter uses
 * this module so that the Typst PDF and the HTML/Chrome output print the same numbers.
 */

export type FloatKind = "figure" | "table" | "equation";

export interface FloatNumber {
  /** Chapter label: a digit string in the body, a letter in annexes, `null` in the front matter. */
  chapter: string | null;
  /** 1-based index inside the chapter. */
  index: number;
  /** 1-based index in the whole document. */
  sequence: number;
}

type Area = "front" | "body" | "annex";

export class Numberer {
  private area: Area = "front";
  private annexStarted = false;
  private chapter = 0;
  private readonly sequence: Record<FloatKind, number> = { figure: 0, table: 0, equation: 0 };
  private readonly perChapter: Record<FloatKind, number> = { figure: 0, table: 0, equation: 0 };

  /** Start a section: front matter, body chapter file or annex file. */
  enterSection(section: Pick<Section, "role">, front = false): void {
    this.area = front ? "front" : section.role === "annex" ? "annex" : "body";
    if (this.area === "annex" && !this.annexStarted) {
      this.annexStarted = true;
      this.chapter = 0;
    }
  }

  /** A heading was reached; a level-1 heading outside the front matter opens a new chapter. */
  enterHeading(level: number, front = false): void {
    if (level === 1 && !front && this.area !== "front") {
      this.chapter += 1;
      this.perChapter.figure = 0;
      this.perChapter.table = 0;
      this.perChapter.equation = 0;
    }
  }

  /** Current chapter label, or `null` in the front matter and before the first chapter. */
  chapterLabel(): string | null {
    if (this.area === "front" || this.chapter === 0) return null;
    return this.area === "annex"
      ? String.fromCharCode(64 + Math.min(this.chapter, 26))
      : String(this.chapter);
  }

  nextFloat(kind: FloatKind): FloatNumber {
    this.sequence[kind] += 1;
    this.perChapter[kind] += 1;
    return {
      chapter: this.chapterLabel(),
      index: this.perChapter[kind],
      sequence: this.sequence[kind],
    };
  }
}

/** Printed number of a float: `2.1` when numbering per chapter, else the running sequence. */
export function floatLabel(number: FloatNumber, perChapter: boolean): string {
  return perChapter && number.chapter !== null
    ? `${number.chapter}.${number.index}`
    : String(number.sequence);
}

// ---------------------------------------------------------------------------------------------
// Heading numbers
// ---------------------------------------------------------------------------------------------

const symbolPattern = /[1AaIi]/;

function roman(value: number, upper: boolean): string {
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let rest = Math.max(0, Math.trunc(value));
  let out = "";
  for (const [size, text] of table) {
    while (rest >= size) {
      out += text;
      rest -= size;
    }
  }
  return upper ? out.toUpperCase() : out;
}

function letters(value: number, upper: boolean): string {
  let rest = Math.max(1, Math.trunc(value));
  let out = "";
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode((upper ? 65 : 97) + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function symbol(kind: string, value: number): string {
  if (kind === "1") return String(value);
  if (kind === "A") return letters(value, true);
  if (kind === "a") return letters(value, false);
  return roman(value, kind === "I");
}

/**
 * Typst-compatible counting pattern (`1.1`, `A.1.1`, `I.`): the text before the first symbol is a
 * prefix, each symbol brings the separator text before it, and the text after the last symbol is
 * a suffix. With more numbers than symbols the last symbol and its separator repeat.
 */
export function formatNumbering(pattern: string, numbers: readonly number[]): string {
  const pieces: { before: string; kind: string }[] = [];
  let prefix = "";
  let suffix = "";
  let pending = "";
  for (const char of pattern) {
    if (symbolPattern.test(char)) {
      if (pieces.length === 0) prefix = pending;
      pieces.push({ before: pieces.length === 0 ? "" : pending, kind: char });
      pending = "";
    } else pending += char;
  }
  suffix = pending;
  if (pieces.length === 0) return numbers.join(".");
  let out = prefix;
  numbers.forEach((value, position) => {
    const piece = pieces[Math.min(position, pieces.length - 1)] as { before: string; kind: string };
    out += (position === 0 ? "" : piece.before) + symbol(piece.kind, value);
  });
  return out + suffix;
}

/** Heading counters (levels 1 to 4) with the per-level and annex patterns of a profile. */
export class HeadingCounter {
  private readonly counters = [0, 0, 0, 0];
  private annex = false;

  constructor(
    private readonly levelPatterns: readonly string[],
    private readonly annexPattern: string,
  ) {}

  /** Begin the annex area: headings are numbered with the annex pattern from zero. */
  startAnnex(): void {
    if (this.annex) return;
    this.annex = true;
    this.counters.fill(0);
  }

  /** Counts a heading and returns its printed number. */
  next(level: number): string {
    const index = Math.min(Math.max(level, 1), 4) - 1;
    this.counters[index] = (this.counters[index] as number) + 1;
    for (let deeper = index + 1; deeper < 4; deeper += 1) this.counters[deeper] = 0;
    const numbers = this.counters.slice(0, index + 1);
    const pattern = this.annex ? this.annexPattern : (this.levelPatterns[index] ?? "1.1");
    return formatNumbering(pattern, numbers);
  }
}
