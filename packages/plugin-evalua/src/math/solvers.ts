import { Rational } from "./rational.js";

/** A single-variable linear equation `a x + b = 0` over the rationals. */
export type LinearSolution =
  | { kind: "one"; root: Rational }
  | { kind: "none" }
  | { kind: "infinite" };

export function solveLinear(a: Rational, b: Rational): LinearSolution {
  if (a.isZero()) return b.isZero() ? { kind: "infinite" } : { kind: "none" };
  return { kind: "one", root: b.neg().div(a) };
}

/**
 * A quadratic equation `a x^2 + b x + c = 0` over the rationals, classified by the exact
 * discriminant. `two` and `one` carry rational roots; `irrational` reports a positive
 * non-square discriminant; `none` a negative one.
 */
export type QuadraticSolution =
  | { kind: "two"; roots: [Rational, Rational] }
  | { kind: "one"; root: Rational }
  | { kind: "irrational"; discriminant: Rational }
  | { kind: "none" };

export function solveQuadratic(a: Rational, b: Rational, c: Rational): QuadraticSolution {
  if (a.isZero()) throw new Error("solveQuadratic requires a non-zero leading coefficient");
  const four = Rational.of(4);
  const two = Rational.of(2);
  const discriminant = b.mul(b).sub(four.mul(a).mul(c));
  const sign = discriminant.sign();
  if (sign < 0) return { kind: "none" };
  if (sign === 0) return { kind: "one", root: b.neg().div(two.mul(a)) };
  const root = discriminant.sqrtExact();
  if (root === undefined) return { kind: "irrational", discriminant };
  const denominator = two.mul(a);
  const left = b.neg().sub(root).div(denominator);
  const right = b.neg().add(root).div(denominator);
  const roots: [Rational, Rational] = left.compare(right) <= 0 ? [left, right] : [right, left];
  return { kind: "two", roots };
}
