import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const linearFunction: Family = {
  id: "linear-function",
  solve(problem: Record<string, unknown>): Rational {
    const x1 = Number(problem.x1);
    const y1 = Number(problem.y1);
    const x2 = Number(problem.x2);
    const y2 = Number(problem.y2);
    return Rational.of(y2 - y1, x2 - x1);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const x1 = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    let x2 = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    if (x2 === x1) x2 = x1 === 0 ? 1 : x1 + 1;
    const y1 = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const y2 = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const answer = Rational.of(y2 - y1, x2 - x1);
    const pool = [
      `La pendiente entre dos puntos es el cambio en y sobre el cambio en x.`,
      `$m = \\dfrac{y_2 - y_1}{x_2 - x_1}$`,
      `$m = \\dfrac{${y2} - (${y1})}{${x2} - (${x1})}$`,
      `Calcula el numerador: $${y2 - y1}$.`,
      `Calcula el denominador: $${x2 - x1}$.`,
      `Divide y simplifica la fracción.`,
      `Una pendiente positiva sube de izquierda a derecha.`,
      `$${answer.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const inverted = y2 === y1 ? answer.add(Rational.one) : Rational.of(x2 - x1, y2 - y1);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: inverted.toString(),
          display: money(inverted),
          error: "inverted-ratio",
        },
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        {
          value: Rational.of(y2 - y1 + (x2 - x1)).toString(),
          display: money(Rational.of(y2 - y1 + (x2 - x1))),
          error: "added-instead",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "linear-function",
      level,
      type: "single_choice",
      stem: [
        "Calcula la pendiente de la recta que pasa por:",
        `$A(${x1}, ${y1})$`,
        `$B(${x2}, ${y2})$`,
        `$m = ?$`,
      ],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [x1, y1, x2, y2],
      stepCount: solution.length,
      problem: { x1, y1, x2, y2 },
    };
  },
};
