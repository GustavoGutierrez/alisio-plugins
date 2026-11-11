/**
 * Exact non-rational answers shared by the secondary families (and the later trigonometry, conics
 * and statistics ones): multiples of π, simplified square roots and decimal displays. Each kind has
 * a canonical text that two equal values always share, so options compare by value, never by look.
 */

import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { OptionCandidate } from "./options.js";
import { decimalString } from "./shared.js";

/** `coefficient·π` as canonical text: `"9pi"`, `"9/2pi"`, `"0"` for zero. */
export function piText(coefficient: Rational): string {
  if (coefficient.isZero()) return "0";
  return `${coefficient.toString()}pi`;
}

/** `coefficient·π` as inline math: `$9\pi$`, `$\dfrac{9}{2}\pi$`, `$\pi$`. */
export function piMath(coefficient: Rational): string {
  if (coefficient.isZero()) return "$0$";
  if (coefficient.isOne()) return "$\\pi$";
  if (coefficient.equals(Rational.one.neg())) return "$-\\pi$";
  return `$${latexRational(coefficient)}\\pi$`;
}

/** An option worth `coefficient·π`. */
export const piChoice = (coefficient: Rational | number, error: string): OptionCandidate => {
  const value = typeof coefficient === "number" ? Rational.of(coefficient) : coefficient;
  return { value: piText(value), display: piMath(value), error };
};

/** `√n = outside·√inside` with `inside` square-free (`√72 = 6√2`); `n` a non-negative integer. */
export function sqrtParts(n: number): { outside: number; inside: number } {
  let outside = 1;
  let inside = Math.max(0, Math.round(n));
  for (let factor = 2; factor * factor <= inside; factor += 1) {
    while (inside % (factor * factor) === 0) {
      inside /= factor * factor;
      outside *= factor;
    }
  }
  return { outside, inside };
}

/** `coefficient·√radicand` canonical text, simplified: `"6sqrt2"`, `"1/2sqrt3"`, or a rational. */
export function surdText(coefficient: Rational, radicand: number): string {
  const { outside, inside } = sqrtParts(radicand);
  const total = coefficient.mul(Rational.of(outside));
  if (inside === 0 || total.isZero()) return "0";
  return inside === 1 ? total.toString() : `${total.toString()}sqrt${inside}`;
}

/** `coefficient·√radicand` as inline math, simplified: `$6\sqrt{2}$`, `$\dfrac{1}{2}\sqrt{3}$`. */
export function surdMath(coefficient: Rational, radicand: number): string {
  const { outside, inside } = sqrtParts(radicand);
  const total = coefficient.mul(Rational.of(outside));
  if (inside === 0 || total.isZero()) return "$0$";
  if (inside === 1) return `$${latexRational(total)}$`;
  const root = `\\sqrt{${inside}}`;
  if (total.isOne()) return `$${root}$`;
  if (total.equals(Rational.one.neg())) return `$-${root}$`;
  if (total.isInteger()) return `$${latexRational(total)}${root}$`;
  // A fractional coefficient is written as the textbook fraction: √3/2, not ½√3.
  const sign = total.sign() < 0 ? "-" : "";
  const top = total.n < 0n ? -total.n : total.n;
  return `$${sign}\\dfrac{${top === 1n ? "" : top}${root}}{${total.d}}$`;
}

/** An option worth `coefficient·√radicand` (a whole number when the root is exact). */
export const surdChoice = (
  radicand: number,
  error: string,
  coefficient: Rational = Rational.one,
): OptionCandidate => ({
  value: surdText(coefficient, radicand),
  display: surdMath(coefficient, radicand),
  error,
});

/** A terminating rational as a Colombian decimal (`3{,}25`) inside inline math. */
export const decimalMath = (value: Rational): string =>
  `$${decimalString(value).replace(".", "{,}")}$`;

/** A terminating decimal option shown with the decimal comma. */
export const decimalChoice = (value: Rational, error: string): OptionCandidate => ({
  value: value.toString(),
  display: decimalMath(value),
  error,
});

/** A point `(x, y)` as canonical text and inline math, for vertex / intercept answers. */
export const pointText = (x: Rational | number, y: Rational | number): string =>
  `(${Rational.from(x).toString()},${Rational.from(y).toString()})`;

export const pointMath = (x: Rational | number, y: Rational | number): string =>
  `$\\left(${latexRational(Rational.from(x))},\\ ${latexRational(Rational.from(y))}\\right)$`;

export const pointChoice = (
  x: Rational | number,
  y: Rational | number,
  error: string,
): OptionCandidate => ({ value: pointText(x, y), display: pointMath(x, y), error });
