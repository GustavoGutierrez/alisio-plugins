import { latexPoly } from "../math/latex.js";
import { Poly } from "../math/poly.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, polyOfX, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const expressionEvaluate: Family = {
  id: "expression-evaluate",
  solve(problem: Record<string, unknown>): Rational {
    return Poly.parse(String(problem.polynomial)).evaluate({ x: Rational.of(Number(problem.x)) });
  },
  generate({ rng, level, calibration }): ItemDraft {
    const degree = rng.int(1, 2);
    const coefficients: number[] = [];
    for (let index = 0; index <= degree; index += 1) {
      coefficients.push(
        index === degree
          ? rangeValue(rng, calibration.coefficientRange)
          : rangeValue(rng, calibration.coefficientRange, { allowZero: true }),
      );
    }
    const polynomial = polyOfX(coefficients);
    const x = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const answer = polynomial.evaluate({ x: Rational.of(x) });
    const atNegative = polynomial.evaluate({ x: Rational.of(-x) });
    const pool = [
      `Substitute $x = ${x}$ in $P(x) = ${latexPoly(polynomial)}$.`,
      `Replace every $x$ by ${x}.`,
      `Compute the powers of ${x}.`,
      `Multiply each coefficient by its power.`,
      `Add the resulting terms.`,
      `Watch the sign of the odd powers.`,
      `Check the arithmetic.`,
      `$${answer.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: atNegative.toString(), display: money(atNegative), error: "sign-error" },
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        {
          value: answer.mul(Rational.of(2)).toString(),
          display: money(answer.mul(Rational.of(2))),
          error: "double-counted",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "expression-evaluate",
      level,
      type: "single_choice",
      stem: [`$P(x) = ${latexPoly(polynomial)}$`, `$P(${x}) = ?$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [...coefficients, x],
      stepCount: solution.length,
      problem: { polynomial: polynomial.toString(), x },
    };
  },
};
