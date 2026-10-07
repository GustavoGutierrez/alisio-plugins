import type { LevelCalibration } from "../knowledge/types.js";
import { latexPoly, latexRational } from "../math/latex.js";
import { Poly } from "../math/poly.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";

/** A non-zero integer inside the calibration range (never zero unless allowed). */
export function rangeValue(
  rng: Rng,
  range: [number, number],
  { allowZero = false, minMagnitude = 0 }: { allowZero?: boolean; minMagnitude?: number } = {},
): number {
  let value = rng.int(range[0], range[1]);
  if (!allowZero && value === 0) value = range[0] <= -1 ? -1 : 1;
  if (Math.abs(value) < minMagnitude) {
    value = value < 0 ? -minMagnitude : minMagnitude;
  }
  if (value < range[0] || value > range[1]) value = Math.min(Math.max(value, range[0]), range[1]);
  return value;
}

/** A positive integer inside the calibration range, at least 1. */
export function positiveValue(rng: Rng, range: [number, number]): number {
  const low = Math.max(1, range[0]);
  const high = Math.max(low, range[1]);
  return rng.int(low, high);
}

/** The level's target solution length, clamped to at least one. */
export function pickSteps(rng: Rng, calibration: LevelCalibration): number {
  const low = Math.max(1, calibration.steps[0]);
  const high = Math.max(low, calibration.steps[1]);
  return rng.int(low, high);
}

/** A sub-range capped at a cheaper magnitude, still inside the level range. */
export function boundedRange(range: [number, number], cap: number): [number, number] {
  const low = Math.max(range[0], -cap);
  const high = Math.min(range[1], cap);
  return low <= high ? [low, high] : range;
}

export const money = (value: Rational): string => `$${latexRational(value)}$`;

/** Guaranteed-distinct fallback distractors around an answer (keeps generators total). */
export function perturb(
  answer: Rational,
  error = "off-by-one",
): Array<{ value: string; display: string; error: string }> {
  const variants = [
    answer.add(Rational.one),
    answer.sub(Rational.one),
    answer.add(Rational.of(2)),
    answer.sub(Rational.of(2)),
  ];
  if (!answer.isZero()) variants.push(answer.neg());
  return variants.map((value) => ({ value: value.toString(), display: money(value), error }));
}

/** Keeps the last `target` lines, so the final answer is always present. */
export function fitPool(pool: string[], target: number): string[] {
  return pool.slice(-target);
}

/** A solution of `pickSteps` lines drawn from a genuine pool (which must have >= 8 lines). */
export function pooled(pool: string[], rng: Rng, calibration: LevelCalibration): string[] {
  return pool.slice(-Math.min(pickSteps(rng, calibration), pool.length));
}

/**
 * The item instruction: an agent-authored template when one is provided (per topic, spec: data),
 * otherwise the family default. `{expr}` is replaced by the item's math so any exam can phrase the
 * question its own way without changing code.
 */
export function prompt(
  rng: Rng,
  prompts: readonly string[] | undefined,
  fallback: string,
  expr: string,
): string {
  const candidates = (prompts ?? []).filter(
    (entry) => typeof entry === "string" && entry.trim() !== "",
  );
  const template = candidates.length > 0 ? (rng.pick(candidates) ?? fallback) : fallback;
  return template.replace(/\{expr\}/g, expr);
}

/** The canonical value and LaTeX display of a polynomial option. */
export function polyValue(poly: Poly): string {
  return poly.toString();
}

export function polyDisplay(poly: Poly): string {
  return `$${latexPoly(poly)}$`;
}

/** Builds a univariate polynomial in x from ascending coefficients. */
export function polyOfX(coefficients: readonly number[]): Poly {
  let out = Poly.zero;
  coefficients.forEach((coefficient, index) => {
    if (coefficient !== 0) {
      out = out.add(Poly.constant(Rational.of(coefficient)).mul(Poly.variable("x").pow(index)));
    }
  });
  return out;
}

/** Text for a linear expression `m x + n` with unambiguous signs. */
export function linearText(m: number, n: number): string {
  const variable = m === 0 ? "" : m === 1 ? "x" : m === -1 ? "-x" : `${m}x`;
  if (n === 0) return variable === "" ? "0" : variable;
  if (variable === "") return `${n}`;
  return `${variable} ${n < 0 ? "-" : "+"} ${Math.abs(n)}`;
}

/** Balanced base-10 decimal text for a rational whose denominator only has 2s and 5s. */
export function decimalString(value: Rational): string {
  if (value.isZero()) return "0";
  let denominator = value.d;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) return value.toString();
  const places = Math.max(twos, fives);
  const scaled = value.abs().mul(Rational.of(10).pow(places)).toBigInt().toString();
  const digits = scaled.padStart(places + 1, "0");
  const integerPart = digits.slice(0, digits.length - places);
  const fractionPart = places === 0 ? "" : `.${digits.slice(digits.length - places)}`;
  return `${value.sign() < 0 ? "-" : ""}${integerPart}${fractionPart}`;
}

/** Prime factorization as an ordered list, smallest factor first. */
export function primeFactors(value: number): number[] {
  let remaining = Math.abs(value);
  const factors: number[] = [];
  let divisor = 2;
  while (divisor * divisor <= remaining) {
    while (remaining % divisor === 0) {
      factors.push(divisor);
      remaining /= divisor;
    }
    divisor += divisor === 2 ? 1 : 2;
  }
  if (remaining > 1) factors.push(remaining);
  return factors;
}

export function gcdOf(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function lcmOf(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs((a / gcdOf(a, b)) * b);
}
