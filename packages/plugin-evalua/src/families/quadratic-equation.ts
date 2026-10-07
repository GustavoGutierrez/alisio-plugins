import { Rational } from "../math/rational.js";
import { solveQuadratic } from "../math/solvers.js";
import { assembleOptions } from "./options.js";
import { pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function canonicalFrom(a: number, b: number, c: number): string {
  const solution = solveQuadratic(Rational.of(a), Rational.of(b), Rational.of(c));
  if (solution.kind === "two") {
    return `x=${solution.roots[0].toString()};x=${solution.roots[1].toString()}`;
  }
  if (solution.kind === "one") return `x=${solution.root.toString()}`;
  return "no-rational-roots";
}

export const quadraticEquation: Family = {
  id: "quadratic-equation",
  solve(problem: Record<string, unknown>): string {
    return canonicalFrom(Number(problem.a), Number(problem.b), Number(problem.c));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const bound = Math.max(1, Math.floor(Math.sqrt(max)));
    const bounded: [number, number] = [-bound, bound];
    const r1 = rangeValue(rng, bounded, { allowZero: true });
    let r2 = rangeValue(rng, bounded, { allowZero: true });
    if (r2 === r1) r2 = r1 === bound ? r1 - 1 : r1 + 1;
    const a = 1;
    const b = -(r1 + r2);
    const c = r1 * r2;
    const canonical = canonicalFrom(a, b, c);
    const pool = [
      `Identify the coefficients: $a = ${a}$, $b = ${b}$, $c = ${c}$.`,
      `Use the quadratic formula $x = \\dfrac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$.`,
      `Discriminant: $b^2 - 4ac = ${b * b - 4 * a * c}$.`,
      `Apply the formula.`,
      `The two roots are $${r1}$ and $${r2}$.`,
      `Check each root by substitution.`,
      `A product of zero gives the roots directly.`,
      `$x = ${r1},\\ x = ${r2}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: canonical, display: `$x = ${r1},\\ x = ${r2}$`, error: "none" },
      [
        {
          value: `x=${r1};x=${-r2}`,
          display: `$x = ${r1},\\ x = ${-r2}$`,
          error: "sign-error",
        },
        {
          value: `x=${r1 + 1};x=${r2}`,
          display: `$x = ${r1 + 1},\\ x = ${r2}$`,
          error: "off-by-one",
        },
        {
          value: `x=${r1 * r2}`,
          display: `$x = ${r1 * r2}$`,
          error: "used-product-as-root",
        },
        {
          value: `x=${-r1};x=${-r2}`,
          display: `$x = ${-r1},\\ x = ${-r2}$`,
          error: "sign-error",
        },
        {
          value: `x=${r1};x=${r2 + 1}`,
          display: `$x = ${r1},\\ x = ${r2 + 1}$`,
          error: "off-by-one",
        },
      ],
    );
    return {
      family: "quadratic-equation",
      level,
      type: "single_choice",
      stem: [
        `$${a}x^{2} ${b < 0 ? "-" : "+"} ${Math.abs(b)}x ${c < 0 ? "-" : "+"} ${Math.abs(c)} = 0$`,
      ],
      options,
      answer: { canonical, display: `$x = ${r1},\\ x = ${r2}$` },
      solution,
      numericValues: [a, b, c],
      stepCount: solution.length,
      problem: { a, b, c },
    };
  },
};
