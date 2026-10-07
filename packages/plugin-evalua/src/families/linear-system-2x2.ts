import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

interface Problem {
  a1: number;
  b1: number;
  a2: number;
  b2: number;
  c1: number;
  c2: number;
}

function cramer(problem: Problem): { x: Rational; y: Rational } {
  const determinant = Rational.of(problem.a1 * problem.b2 - problem.a2 * problem.b1);
  const x = Rational.of(problem.c1 * problem.b2 - problem.c2 * problem.b1).div(determinant);
  const y = Rational.of(problem.a1 * problem.c2 - problem.a2 * problem.c1).div(determinant);
  return { x, y };
}

export const linearSystem2x2: Family = {
  id: "linear-system-2x2",
  solve(problem: Record<string, unknown>): string {
    const { x, y } = cramer(problem as unknown as Problem);
    return `x=${x.toString()};y=${y.toString()}`;
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const bound = Math.max(1, Math.floor(Math.sqrt(max / 2)));
    const bounded: [number, number] = [-bound, bound];
    let a1 = rangeValue(rng, bounded);
    let b1 = rangeValue(rng, bounded);
    let a2 = rangeValue(rng, bounded);
    let b2 = rangeValue(rng, bounded);
    let guard = 0;
    while (a1 * b2 - a2 * b1 === 0 && guard < 20) {
      a2 = rangeValue(rng, bounded);
      b2 = rangeValue(rng, bounded);
      guard += 1;
    }
    if (a1 * b2 - a2 * b1 === 0) {
      a1 = 1;
      b1 = 0;
      a2 = 0;
      b2 = 1;
    }
    const x0 = rangeValue(rng, bounded, { allowZero: true });
    const y0 = rangeValue(rng, bounded, { allowZero: true });
    const c1 = a1 * x0 + b1 * y0;
    const c2 = a2 * x0 + b2 * y0;
    const problem: Problem = { a1, b1, a2, b2, c1, c2 };
    const { x, y } = cramer(problem);
    const canonical = `x=${x.toString()};y=${y.toString()}`;
    const pool = [
      `Write both equations together.`,
      `$${a1}x ${b1 < 0 ? "-" : "+"} ${Math.abs(b1)}y = ${c1}$`,
      `$${a2}x ${b2 < 0 ? "-" : "+"} ${Math.abs(b2)}y = ${c2}$`,
      `Eliminate one variable by adding or subtracting the equations.`,
      `Solve the resulting one-variable equation.`,
      `Substitute back to find the other variable.`,
      `Check the solution in both equations.`,
      `$x = ${x.toString()},\\ y = ${y.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: canonical, display: `$x = ${x.toString()},\\ y = ${y.toString()}$`, error: "none" },
      [
        {
          value: `x=${y.toString()};y=${x.toString()}`,
          display: `$x = ${y.toString()},\\ y = ${x.toString()}$`,
          error: "swapped-variables",
        },
        {
          value: `x=${x.neg().toString()};y=${y.neg().toString()}`,
          display: `$x = ${x.neg().toString()},\\ y = ${y.neg().toString()}$`,
          error: "sign-error",
        },
        {
          value: `x=${x.add(Rational.one).toString()};y=${y.toString()}`,
          display: `$x = ${x.add(Rational.one).toString()},\\ y = ${y.toString()}$`,
          error: "off-by-one",
        },
        {
          value: `x=${x.toString()};y=${y.add(Rational.one).toString()}`,
          display: `$x = ${x.toString()},\\ y = ${y.add(Rational.one).toString()}$`,
          error: "off-by-one",
        },
        {
          value: `x=${x.add(Rational.of(2)).toString()};y=${y.toString()}`,
          display: `$x = ${x.add(Rational.of(2)).toString()},\\ y = ${y.toString()}$`,
          error: "off-by-two",
        },
        {
          value: `x=${x.toString()};y=${y.add(Rational.of(2)).toString()}`,
          display: `$x = ${x.toString()},\\ y = ${y.add(Rational.of(2)).toString()}$`,
          error: "off-by-two",
        },
        {
          value: `x=${y.toString()};y=${y.toString()}`,
          display: `$x = ${y.toString()},\\ y = ${y.toString()}$`,
          error: "reused-value",
        },
        {
          value: "x=0;y=0",
          display: "$x = 0,\\ y = 0$",
          error: "zero-guess",
        },
      ],
    );
    return {
      family: "linear-system-2x2",
      level,
      type: "single_choice",
      stem: [
        "Resuelve el sistema de ecuaciones:",
        `$${a1}x ${b1 < 0 ? "-" : "+"} ${Math.abs(b1)}y = ${c1}$`,
        `$${a2}x ${b2 < 0 ? "-" : "+"} ${Math.abs(b2)}y = ${c2}$`,
      ],
      options,
      answer: { canonical, display: `$x = ${x.toString()},\\ y = ${y.toString()}$` },
      solution,
      numericValues: [a1, b1, a2, b2, c1, c2],
      stepCount: solution.length,
      problem: { ...problem },
    };
  },
};
