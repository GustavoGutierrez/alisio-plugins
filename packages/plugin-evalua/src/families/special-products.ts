import { latexPoly } from "../math/latex.js";
import { assembleOptions } from "./options.js";
import { polyDisplay, polyOfX, polyValue, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function factorX(root: number): string {
  if (root === 0) return "x";
  return `\\left(x ${root < 0 ? "-" : "+"} ${Math.abs(root)}\\right)`;
}

export const specialProducts: Family = {
  id: "special-products",
  solve(problem: Record<string, unknown>) {
    if (problem.mode === "square") {
      const a = Number(problem.a);
      return polyOfX([a * a, 2 * a, 1]);
    }
    const a = Number(problem.a);
    const b = Number(problem.b);
    return polyOfX([a * b, a + b, 1]);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const mode = rng.int(0, 1) === 0 ? "square" : "product";
    if (mode === "square") {
      const a = rangeValue(rng, calibration.coefficientRange);
      const answer = polyOfX([a * a, 2 * a, 1]);
      const pool = [
        `A square of a binomial is the product of the binomial with itself.`,
        `$${factorX(a)}^{2} = ${factorX(a)}${factorX(a)}$`,
        `Square the first term: $x^2$.`,
        `Twice the product of the terms: $2 \\cdot x \\cdot ${a}$.`,
        `Square the second term: $${a * a}$.`,
        `Combine the three terms.`,
        `The middle term is always even here.`,
        `$${latexPoly(answer)}$`,
      ];
      const solution = pooled(pool, rng, calibration);
      const options = assembleOptions(
        rng,
        { value: polyValue(answer), display: polyDisplay(answer), error: "none" },
        [
          {
            value: polyValue(polyOfX([a * a, 0, 1])),
            display: polyDisplay(polyOfX([a * a, 0, 1])),
            error: "forgot-middle-term",
          },
          {
            value: polyValue(polyOfX([a * a, a, 1])),
            display: polyDisplay(polyOfX([a * a, a, 1])),
            error: "halved-middle-term",
          },
          {
            value: polyValue(polyOfX([a, 2 * a, 1])),
            display: polyDisplay(polyOfX([a, 2 * a, 1])),
            error: "wrong-constant",
          },
          {
            value: polyValue(polyOfX([a * a, -2 * a, 1])),
            display: polyDisplay(polyOfX([a * a, -2 * a, 1])),
            error: "sign-error",
          },
          {
            value: polyValue(polyOfX([0, 2 * a, 1])),
            display: polyDisplay(polyOfX([0, 2 * a, 1])),
            error: "dropped-constant",
          },
        ],
      );
      return {
        family: "special-products",
        level,
        type: "single_choice",
        stem: [`Desarrolla el producto notable: $${factorX(a)}^{2}$`],
        options,
        answer: { canonical: polyValue(answer), display: polyDisplay(answer) },
        solution,
        numericValues: [a],
        stepCount: solution.length,
        problem: { mode, a },
      };
    }
    const a = rangeValue(rng, calibration.coefficientRange);
    const b = rangeValue(rng, calibration.coefficientRange);
    const answer = polyOfX([a * b, a + b, 1]);
    const pool = [
      `Multiply the two binomials term by term.`,
      `$${factorX(a)}${factorX(b)}$`,
      `First terms: $x \\cdot x = x^2$.`,
      `Outer and inner terms: $${a}x + ${b}x = ${a + b}x$.`,
      `Last terms: $${a} \\cdot ${b} = ${a * b}$.`,
      `Combine like terms.`,
      `The middle coefficient is the sum of the constants.`,
      `$${latexPoly(answer)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: polyValue(answer), display: polyDisplay(answer), error: "none" },
      [
        {
          value: polyValue(polyOfX([a + b, a * b, 1])),
          display: polyDisplay(polyOfX([a + b, a * b, 1])),
          error: "swapped-sum-and-product",
        },
        {
          value: polyValue(polyOfX([a * b, a - b, 1])),
          display: polyDisplay(polyOfX([a * b, a - b, 1])),
          error: "sign-error",
        },
        {
          value: polyValue(polyOfX([a * b, 0, 1])),
          display: polyDisplay(polyOfX([a * b, 0, 1])),
          error: "forgot-middle-term",
        },
        {
          value: polyValue(polyOfX([a * b, -(a + b), 1])),
          display: polyDisplay(polyOfX([a * b, -(a + b), 1])),
          error: "sign-error",
        },
        {
          value: polyValue(polyOfX([a * b + 1, a + b, 1])),
          display: polyDisplay(polyOfX([a * b + 1, a + b, 1])),
          error: "wrong-constant",
        },
      ],
    );
    return {
      family: "special-products",
      level,
      type: "single_choice",
      stem: [`Desarrolla el producto: $${factorX(a)}${factorX(b)}$`],
      options,
      answer: { canonical: polyValue(answer), display: polyDisplay(answer) },
      solution,
      numericValues: [a, b],
      stepCount: solution.length,
      problem: { mode, a, b },
    };
  },
};
