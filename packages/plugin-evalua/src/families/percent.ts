import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, positiveValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const percent: Family = {
  id: "percent",
  solve(problem: Record<string, unknown>): Rational {
    const part = Rational.of(Number(problem.percent));
    const base = Rational.of(Number(problem.base));
    return part.mul(base).div(Rational.of(100));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const percentValue = positiveValue(rng, calibration.coefficientRange);
    const base = positiveValue(rng, calibration.coefficientRange);
    const answer = Rational.of(percentValue).mul(Rational.of(base)).div(Rational.of(100));
    const times = Rational.of(percentValue * base);
    const pool = [
      `Escribe el porcentaje como fracción: $${percentValue}\\% = \\dfrac{${percentValue}}{100}$`,
      `Multiplica esa fracción por ${base}.`,
      `Combina: $\\dfrac{${percentValue}}{100} \\cdot ${base}$.`,
      "Simplifica la fracción.",
      "Divide el numerador y el denominador entre su mcd.",
      "Comprueba el resultado estimando.",
      "El resultado es:",
      `$${latexRational(answer)}$`,
    ];
    const target = rng.int(Math.max(1, calibration.steps[0]), Math.max(1, calibration.steps[1]));
    const solution = pool.slice(-Math.min(target, pool.length));
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: times.toString(), display: money(times), error: "forgot-dividing-by-100" },
        {
          value: Rational.of(base).div(Rational.of(percentValue)).toString(),
          display: money(Rational.of(base).div(Rational.of(percentValue))),
          error: "inverted-ratio",
        },
        {
          value: Rational.of(base - percentValue).toString(),
          display: money(Rational.of(base - percentValue)),
          error: "subtracted-instead",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "percent",
      level,
      type: "single_choice",
      stem: [`Calcula el porcentaje: $${percentValue}\\% \\cdot ${base}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [percentValue, base],
      stepCount: solution.length,
      problem: { percent: percentValue, base },
    };
  },
};
