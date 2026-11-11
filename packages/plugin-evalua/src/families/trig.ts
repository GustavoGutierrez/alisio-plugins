/**
 * Exact trigonometric values at the special angles (multiples of 30° and 45°), shared by the
 * right-triangle and unit-circle families. A value is `coefficient·√radicand` with `radicand` 1, 2
 * or 3, so `sen 60° = ½√3` is `{ 1/2, 3 }`; the tangent of a quadrantal angle may be undefined.
 */

import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { surdMath, surdText } from "./exact.js";
import type { OptionCandidate } from "./options.js";

export type TrigFn = "sin" | "cos" | "tan";

export interface Exact {
  coefficient: Rational;
  radicand: number;
}

const half = Rational.of(1, 2);
const exact = (coefficient: Rational, radicand = 1): Exact => ({ coefficient, radicand });

/** sin and cos of the first-quadrant special angles. */
const FIRST: Record<number, { sin: Exact; cos: Exact }> = {
  0: { sin: exact(Rational.zero), cos: exact(Rational.one) },
  30: { sin: exact(half), cos: exact(half, 3) },
  45: { sin: exact(half, 2), cos: exact(half, 2) },
  60: { sin: exact(half, 3), cos: exact(half) },
  90: { sin: exact(Rational.one), cos: exact(Rational.zero) },
};

/** The angle reduced to `[0, 360)`. */
export const normalized = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** The acute (or quadrantal) reference angle of any angle. */
export function referenceAngle(degrees: number): number {
  const d = normalized(degrees);
  if (d <= 90) return d;
  if (d <= 180) return 180 - d;
  if (d <= 270) return d - 180;
  return 360 - d;
}

/** The quadrant 1-4 of an angle off the axes, 0 on an axis. */
export function quadrantOf(degrees: number): 0 | 1 | 2 | 3 | 4 {
  const d = normalized(degrees);
  if (d % 90 === 0) return 0;
  return (Math.floor(d / 90) + 1) as 1 | 2 | 3 | 4;
}

const negate = (value: Exact): Exact => exact(value.coefficient.neg(), value.radicand);

/** `sin`, `cos` or `tan` of a special angle, exactly; `undefined` for tan 90° and tan 270°. */
export function trigValue(fn: TrigFn, degrees: number): Exact | undefined {
  const d = normalized(degrees);
  const base = FIRST[referenceAngle(d)];
  if (base === undefined) throw new Error(`not a special angle: ${degrees}`);
  const sinSign = d > 180 ? -1 : 1;
  const cosSign = d > 90 && d < 270 ? -1 : 1;
  const sin = sinSign < 0 ? negate(base.sin) : base.sin;
  const cos = cosSign < 0 ? negate(base.cos) : base.cos;
  if (fn === "sin") return sin;
  if (fn === "cos") return cos;
  if (cos.coefficient.isZero()) return undefined;
  // (a√m)/(b√n) with m, n in {1, 2, 3}: rationalised to (a/(b·n))·√(m·n), then simplified.
  return exact(
    sin.coefficient.div(cos.coefficient.mul(Rational.of(cos.radicand))),
    sin.radicand * cos.radicand,
  );
}

/** `trigValue` for an angle where the function is known to be defined (throws otherwise). */
export function trigAt(fn: TrigFn, degrees: number): Exact {
  const value = trigValue(fn, degrees);
  if (value === undefined) throw new Error(`${fn} is undefined at ${degrees}°`);
  return value;
}

/** The value written canonically (`1/2sqrt3`), the same text `surdText` gives. */
export const exactText = (value: Exact): string => surdText(value.coefficient, value.radicand);

export const exactMath = (value: Exact): string => surdMath(value.coefficient, value.radicand);

export const exactNumber = (value: Exact): number =>
  value.coefficient.toNumber() * Math.sqrt(value.radicand);

/** `value²`, always rational at a special angle. */
export const exactSquare = (value: Exact): Rational =>
  value.coefficient.mul(value.coefficient).mul(Rational.of(value.radicand));

export const exactChoice = (value: Exact, error: string): OptionCandidate => ({
  value: exactText(value),
  display: exactMath(value),
  error,
});

/** `k·value` exactly. */
export const scaleExact = (value: Exact, k: Rational | number): Exact =>
  exact(value.coefficient.mul(Rational.from(k)), value.radicand);

/** `1 / value`, rationalised: `1/(a√n) = (1/(a·n))·√n`. */
export const invertExact = (value: Exact): Exact =>
  exact(Rational.one.div(value.coefficient.mul(Rational.of(value.radicand))), value.radicand);

/** The LaTeX name of a function, Spanish `sen` for the sine. */
export const fnLatex = (fn: TrigFn): string =>
  fn === "sin" ? "\\operatorname{sen}" : fn === "cos" ? "\\cos" : "\\tan";

/** The Spanish word for a function, for the solution text. */
export const fnName = (fn: TrigFn): string =>
  fn === "sin" ? "seno" : fn === "cos" ? "coseno" : "tangente";

/** An angle in degrees as inline math: `$150^\circ$`. */
export const degreeMath = (degrees: number): string => `$${degrees}^\\circ$`;

export const degreeChoice = (degrees: number, error: string): OptionCandidate => ({
  value: String(degrees),
  display: degreeMath(degrees),
  error,
});

/** Degrees as a multiple of π in LaTeX without the dollars: `\dfrac{5}{6}\pi`. */
export function radianLatex(degrees: number): string {
  const coefficient = Rational.of(degrees, 180);
  if (coefficient.isZero()) return "0";
  if (coefficient.isOne()) return "\\pi";
  if (coefficient.equals(Rational.one.neg())) return "-\\pi";
  return `${latexRational(coefficient)}\\pi`;
}

/** Degrees as plain text in radians, for a figure label: `5π/6`, `π`, `2π`. */
export function radianPlain(degrees: number): string {
  const coefficient = Rational.of(degrees, 180);
  const top = coefficient.n === 1n ? "π" : coefficient.n === -1n ? "-π" : `${coefficient.n}π`;
  return coefficient.d === 1n ? top : `${top}/${coefficient.d}`;
}
