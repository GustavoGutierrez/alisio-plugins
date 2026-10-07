import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, positiveValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

interface Problem {
  a: number;
  b: number;
  c: number;
}

export const proportion: Family = {
  id: "proportion",
  solve(problem: Record<string, unknown>): Rational {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    return Rational.of(a * c, b);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const a = positiveValue(rng, calibration.coefficientRange);
    const b = positiveValue(rng, calibration.coefficientRange);
    const c = positiveValue(rng, calibration.coefficientRange);
    const answer = Rational.of(a * c, b);
    const pool = [
      `The proportion is $\\dfrac{${a}}{${b}} = \\dfrac{x}{${c}}$.`,
      `Cross multiply: $${a} \\cdot ${c} = ${b} \\cdot x$.`,
      `$${a * c} = ${b} x$`,
      `Divide both sides by ${b}.`,
      `$x = \\dfrac{${a * c}}{${b}}$`,
      `Simplify the fraction.`,
      `Check that the two ratios are equal.`,
      `$${answer.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: Rational.of(b * c, a).toString(),
          display: money(Rational.of(b * c, a)),
          error: "inverted-ratio",
        },
        {
          value: Rational.of(a * b, c).toString(),
          display: money(Rational.of(a * b, c)),
          error: "multiplied-wrong-pair",
        },
        {
          value: Rational.of(a + c).toString(),
          display: money(Rational.of(a + c)),
          error: "added-instead",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "proportion",
      level,
      type: "single_choice",
      stem: [`$\\dfrac{${a}}{${b}} = \\dfrac{x}{${c}}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a, b, c],
      stepCount: solution.length,
      problem: { a, b, c } satisfies Problem,
    };
  },
};
