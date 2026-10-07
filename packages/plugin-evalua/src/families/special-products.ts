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
        `El cuadrado de un binomio es el producto del binomio por sí mismo.`,
        `$${factorX(a)}^{2} = ${factorX(a)}${factorX(a)}$`,
        `Eleva al cuadrado el primer término: $x^2$.`,
        `El doble del producto de los términos: $2 \\cdot x \\cdot ${a}$.`,
        `Eleva al cuadrado el segundo término: $${a * a}$.`,
        `Combina los tres términos.`,
        `El término del medio siempre es par aquí.`,
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
      `Multiplica los dos binomios término a término.`,
      `$${factorX(a)}${factorX(b)}$`,
      `Primeros términos: $x \\cdot x = x^2$.`,
      `Términos externos e internos: $${a}x + ${b}x = ${a + b}x$.`,
      `Últimos términos: $${a} \\cdot ${b} = ${a * b}$.`,
      `Combina los términos semejantes.`,
      `El coeficiente del medio es la suma de las constantes.`,
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
