import { assembleOptions } from "./options.js";
import { polyDisplay, polyOfX, polyValue, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const likeTerms: Family = {
  id: "like-terms",
  solve(problem: Record<string, unknown>) {
    return polyOfX([0, Number(problem.a) + Number(problem.b)]);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const a = rangeValue(rng, calibration.coefficientRange);
    let b = rangeValue(rng, calibration.coefficientRange);
    let guard = 0;
    while (a + b === 0 && guard < 10) {
      b = rangeValue(rng, calibration.coefficientRange);
      guard += 1;
    }
    if (a + b === 0) b = a === 1 ? 2 : a - 1;
    const answer = polyOfX([0, a + b]);
    const first = `${a < 0 ? "-" : ""}${Math.abs(a)}x`;
    const second = `${b < 0 ? "-" : "+"} ${Math.abs(b)}x`;
    const pool = [
      "The terms are like terms: both have the same variable x.",
      "Only the coefficients are combined.",
      `$${a} + ${b} = ${a + b}$`,
      `Keep the variable unchanged.`,
      `$${a}x + ${b}x = ${a + b}x$`,
      "The exponent of x does not change.",
      "Check the signs of the coefficients.",
      `$${a + b}x$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: polyValue(answer), display: polyDisplay(answer), error: "none" },
      [
        {
          value: polyValue(polyOfX([0, a * b])),
          display: polyDisplay(polyOfX([0, a * b])),
          error: "multiplied-coefficients",
        },
        {
          value: polyValue(polyOfX([0, a - b])),
          display: polyDisplay(polyOfX([0, a - b])),
          error: "subtracted-coefficients",
        },
        {
          value: polyValue(polyOfX([0, 0, a + b])),
          display: polyDisplay(polyOfX([0, 0, a + b])),
          error: "added-exponents",
        },
        {
          value: polyValue(polyOfX([a + b])),
          display: polyDisplay(polyOfX([a + b])),
          error: "dropped-variable",
        },
        {
          value: polyValue(polyOfX([a + b, a + b])),
          display: polyDisplay(polyOfX([a + b, a + b])),
          error: "added-constant",
        },
        {
          value: polyValue(polyOfX([0, -(a + b)])),
          display: polyDisplay(polyOfX([0, -(a + b)])),
          error: "sign-error",
        },
      ],
    );
    return {
      family: "like-terms",
      level,
      type: "single_choice",
      stem: [`$${first} ${second}$`],
      options,
      answer: { canonical: polyValue(answer), display: polyDisplay(answer) },
      solution,
      numericValues: [a, b],
      stepCount: solution.length,
      problem: { a, b },
    };
  },
};
