import { latexPoly } from "../math/latex.js";
import type { Poly } from "../math/poly.js";
import { assembleOptions } from "./options.js";
import { polyDisplay, polyOfX, polyValue, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Operator = "+" | "-" | "*";

function combine(p: Poly, q: Poly, operator: Operator): Poly {
  if (operator === "+") return p.add(q);
  if (operator === "-") return p.sub(q);
  return p.mul(q);
}

export const polynomialOps: Family = {
  id: "polynomial-ops",
  solve(problem: Record<string, unknown>) {
    return combine(
      polyOfX(problem.p as number[]),
      polyOfX(problem.q as number[]),
      problem.operator as Operator,
    );
  },
  generate({ rng, level, calibration }): ItemDraft {
    const degree = rng.int(1, 2);
    const build = (): number[] => {
      const coefficients: number[] = [];
      for (let index = 0; index <= degree; index += 1) {
        coefficients.push(
          index === degree
            ? rangeValue(rng, calibration.coefficientRange)
            : rangeValue(rng, calibration.coefficientRange, { allowZero: true }),
        );
      }
      return coefficients;
    };
    const pCoefficients = build();
    const qCoefficients = build();
    const p = polyOfX(pCoefficients);
    const q = polyOfX(qCoefficients);
    const operator = rng.pick(["+", "-", "*"] as const);
    const answer = combine(p, q, operator);
    const numericValues = [...pCoefficients, ...qCoefficients];
    const pool = [
      `Write both polynomials in descending degree order.`,
      `$${latexPoly(p)}$ and $${latexPoly(q)}$`,
      operator === "*"
        ? "Multiply every term of the first by every term of the second."
        : "Align like terms before operating.",
      operator === "*"
        ? "Add the exponents of x in each product."
        : "Combine the coefficients of like terms.",
      "Keep the sign of each term.",
      "Reduce like terms.",
      "Check the degree of the result.",
      `$${latexPoly(answer)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: polyValue(answer), display: polyDisplay(answer), error: "none" },
      [
        { value: polyValue(p.add(q)), display: polyDisplay(p.add(q)), error: "wrong-operation" },
        { value: polyValue(p.sub(q)), display: polyDisplay(p.sub(q)), error: "wrong-operation" },
        { value: polyValue(p.mul(q)), display: polyDisplay(p.mul(q)), error: "wrong-operation" },
        {
          value: polyValue(p.sub(q).neg()),
          display: polyDisplay(p.sub(q).neg()),
          error: "sign-error",
        },
      ],
    );
    return {
      family: "polynomial-ops",
      level,
      type: "single_choice",
      stem: [
        `Efectúa la operación: $\\left(${latexPoly(p)}\\right) ${operator === "*" ? "\\cdot" : operator} \\left(${latexPoly(q)}\\right)$`,
      ],
      options,
      answer: { canonical: polyValue(answer), display: polyDisplay(answer) },
      solution,
      numericValues,
      stepCount: solution.length,
      problem: { p: pCoefficients, q: qCoefficients, operator },
    };
  },
};
