import { latexPoly } from "../math/latex.js";
import { assembleOptions } from "./options.js";
import { polyDisplay, polyOfX, polyValue, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const rationalExpression: Family = {
  id: "rational-expression",
  solve(problem: Record<string, unknown>) {
    return polyOfX([Number(problem.q0), Number(problem.q1)]);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const q0 = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const q1 = rangeValue(rng, calibration.coefficientRange);
    const r = rangeValue(rng, calibration.coefficientRange);
    const quotient = polyOfX([q0, q1]);
    const divisor = polyOfX([-r, 1]);
    const numerator = quotient.mul(divisor);
    const pool = [
      `Factor the numerator if possible.`,
      `$${latexPoly(numerator)}$`,
      `The denominator is $${latexPoly(divisor)}$.`,
      `Look for the common factor $${latexPoly(divisor)}$.`,
      `Divide numerator and denominator by that factor.`,
      `The quotient is $${latexPoly(quotient)}$.`,
      `State the restriction that the denominator is not zero.`,
      `$${latexPoly(quotient)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: polyValue(quotient), display: polyDisplay(quotient), error: "none" },
      [
        {
          value: polyValue(quotient.neg()),
          display: polyDisplay(quotient.neg()),
          error: "sign-error",
        },
        {
          value: polyValue(polyOfX([q0, -q1])),
          display: polyDisplay(polyOfX([q0, -q1])),
          error: "sign-of-x-term",
        },
        {
          value: polyValue(polyOfX([q0, q1, 1])),
          display: polyDisplay(polyOfX([q0, q1, 1])),
          error: "wrong-degree",
        },
        {
          value: polyValue(quotient.mul(polyOfX([0, 1]))),
          display: polyDisplay(quotient.mul(polyOfX([0, 1]))),
          error: "multiplied-by-x",
        },
        {
          value: polyValue(quotient.add(polyOfX([1]))),
          display: polyDisplay(quotient.add(polyOfX([1]))),
          error: "wrong-constant",
        },
      ],
    );
    return {
      family: "rational-expression",
      level,
      type: "single_choice",
      stem: [
        `Simplifica la expresión racional: $\\dfrac{${latexPoly(numerator)}}{${latexPoly(divisor)}}$`,
      ],
      options,
      answer: { canonical: polyValue(quotient), display: polyDisplay(quotient) },
      solution,
      numericValues: [q0, q1, r],
      stepCount: solution.length,
      problem: { q0, q1, r },
    };
  },
};
