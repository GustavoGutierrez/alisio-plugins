/**
 * Building blocks shared by the word-problem and figure families (primary school onwards): typed
 * option candidates, Spanish number/money/time formatting, level helpers, and `finishDraft`, which
 * turns a computed problem into a verified-shape `ItemDraft` the same way every family does.
 */

import type { LevelCalibration } from "../knowledge/types.js";
import type { MarkupLine } from "../markup.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { type Level, levels } from "../types.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled } from "./shared.js";
import type { ItemDraft } from "./types.js";

/** 0 for basico up to 3 for genio, so a family can scale its variants with the level. */
export const levelIndex = (level: Level): number => Math.max(0, levels.indexOf(level));

/** The largest whole number the level allows, capped so a figure or story stays readable. */
export function levelHigh(calibration: LevelCalibration, cap: number, floor = 2): number {
  return Math.max(floor, Math.min(cap, Math.floor(calibration.coefficientRange[1])));
}

/** A numeric option: canonical rational value, LaTeX display. */
export function numberChoice(value: Rational | number, error: string): OptionCandidate {
  const rational = typeof value === "number" ? Rational.of(value) : value;
  return { value: rational.toString(), display: money(rational), error };
}

/** A numeric option written in its own display (e.g. an unreduced fraction or a decimal). */
export function shownChoice(value: Rational, display: string, error: string): OptionCandidate {
  return { value: value.toString(), display, error };
}

/** A word option (a class, a name, a time): the canonical value is the text itself. */
export function textChoice(value: string, error: string, display = value): OptionCandidate {
  return { value, display, error };
}

/** Thousands with the Colombian dot (`12{.}500`), safe inside LaTeX. */
export function thousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, "{.}");
}

/**
 * A peso amount as inline math. The sign is `\textdollar`, never a bare `$`, which would end the
 * inline formula in the markup tokenizer.
 */
export const pesos = (value: number): string => `$\\text{\\textdollar}${thousands(value)}$`;

/** A clock time `h:mm` as canonical text. */
export const clockText = (hour: number, minute: number): string =>
  `${hour}:${String(minute).padStart(2, "0")}`;

/** A clock time as inline math (`$8{:}05$`). */
export const clockMath = (hour: number, minute: number): string =>
  `$${hour}{:}${String(minute).padStart(2, "0")}$`;

/** `$\dfrac{n}{d}$` without reducing, for "what fraction is shaded" style displays. */
export const fractionMath = (numerator: number, denominator: number): string =>
  `$\\dfrac{${numerator}}{${denominator}}$`;

/** Up to `count` distinct integers in `[low, high]` outside `exclude`, seeded and total. */
export function distinctInts(
  rng: Rng,
  count: number,
  low: number,
  high: number,
  exclude: ReadonlySet<number> = new Set(),
): number[] {
  const out = new Set<number>();
  for (let guard = 0; guard < 200 && out.size < count; guard += 1) {
    const value = rng.int(low, high);
    if (!exclude.has(value)) out.add(value);
  }
  for (let value = low; value <= high && out.size < count; value += 1) {
    if (!exclude.has(value)) out.add(value);
  }
  return [...out];
}

/** Lines that open a solution; the pool is padded from these so every level has enough lines. */
const OPENERS = [
  "Lee con atención el enunciado.",
  "Identifica los datos del problema.",
  "Decide qué operación o qué propiedad necesitas.",
  "Escribe el planteamiento.",
  "Resuelve paso a paso.",
  "Revisa que el resultado tenga sentido.",
];

/** Pads a solution pool at the front to at least `size` lines; the last lines stay the answer. */
export function padPool(pool: readonly string[], size = 8): string[] {
  const missing = Math.max(0, size - pool.length);
  return [...OPENERS.slice(0, missing), ...pool];
}

export interface FinishInput {
  family: string;
  level: Level;
  rng: Rng;
  calibration: LevelCalibration;
  stem: MarkupLine[];
  correct: OptionCandidate;
  distractors: readonly OptionCandidate[];
  /** Solution lines, answer last; padded to eight lines and cut to the level's step count. */
  pool: readonly string[];
  numericValues: number[];
  problem: Record<string, unknown>;
  /**
   * Fallback distractors for a numeric answer when the named ones collide: `natural` keeps them
   * non-negative whole numbers (primary school), `any` allows every neighbour, `none` adds nothing.
   */
  fallback?: "natural" | "any" | "none";
}

/** Assembles options, the pooled solution and the draft, exactly like the hand-written families. */
export function finishDraft(input: FinishInput): ItemDraft {
  const mode = input.fallback ?? "natural";
  const extra: OptionCandidate[] = [];
  if (mode !== "none" && /^-?\d+(\/\d+)?$/.test(input.correct.value)) {
    const answer = Rational.parse(input.correct.value);
    for (const candidate of perturb(answer)) {
      const value = Rational.parse(candidate.value);
      if (mode === "natural" && (value.sign() < 0 || !value.isInteger())) continue;
      extra.push(candidate);
    }
  }
  const options = assembleOptions(input.rng, input.correct, [...input.distractors, ...extra]);
  const solution = pooled(padPool(input.pool), input.rng, input.calibration);
  return {
    family: input.family,
    level: input.level,
    type: "single_choice",
    stem: input.stem,
    options,
    answer: { canonical: input.correct.value, display: input.correct.display },
    solution,
    numericValues: input.numericValues,
    stepCount: solution.length,
    problem: input.problem,
  };
}

/** `$value$` for a rational, the display every numeric answer uses. */
export const math = (value: Rational | number): string =>
  `$${latexRational(typeof value === "number" ? Rational.of(value) : value)}$`;

/** The entry of a per-level table (basico first), the last one for any higher index. */
export function tier<T>(index: number, table: readonly (readonly T[])[]): T[] {
  return [...(table[Math.min(index, table.length - 1)] ?? table[0] ?? [])];
}
