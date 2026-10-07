import { Rational } from "../math/rational.js";
import { solveLinear } from "../math/solvers.js";
import { assembleOptions } from "./options.js";
import { linearText, money, perturb, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

export const linearEquation: Family = {
  id: "linear-equation",
  solve(problem: Record<string, unknown>): Rational {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    const d = Number(problem.d);
    const solution = solveLinear(Rational.of(a - c), Rational.of(b - d));
    return solution.kind === "one" ? solution.root : Rational.zero;
  },
  generate({ rng, level, calibration }): ItemDraft {
    const pick = () => rangeValue(rng, calibration.coefficientRange);
    const a = pick();
    let c = pick();
    if (c === a) c = a === 1 ? 2 : a - 1;
    const b = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const d = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const solution = solveLinear(Rational.of(a - c), Rational.of(b - d));
    const answer = solution.kind === "one" ? solution.root : Rational.zero;
    const pool = [
      `Pasa los términos con x a un lado y los números al otro.`,
      `$${linearText(a, b)} = ${linearText(c, d)}$`,
      `$${linearText(a - c, b - d)} = 0$`,
      `Suma el opuesto del término constante.`,
      `Divide ambos lados entre el coeficiente de x.`,
      `$${a - c}\\,x = ${d - b}$`,
      `Comprueba sustituyendo el valor.`,
      `$${answer.toString()}$`,
    ];
    const pooledSolution = pooled(pool, rng, calibration);
    const alternate = a + c === 0 ? answer.add(Rational.one) : Rational.of(d - b, a + c);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        {
          value: alternate.toString(),
          display: money(alternate),
          error: "added-coefficients",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "linear-equation",
      level,
      type: "single_choice",
      stem: [`Resuelve la ecuación: $${linearText(a, b)} = ${linearText(c, d)}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution: pooledSolution,
      numericValues: [a, b, c, d],
      stepCount: pooledSolution.length,
      problem: { a, b, c, d },
    };
  },
};
