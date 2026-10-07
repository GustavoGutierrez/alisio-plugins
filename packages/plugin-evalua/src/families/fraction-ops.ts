import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Operator = "+" | "-" | "*" | "/";

interface Fraction {
  n: number;
  d: number;
}

function fractionBody(value: Fraction): string {
  const sign = value.n < 0 ? "-" : "";
  return `${sign}\\dfrac{${Math.abs(value.n)}}{${value.d}}`;
}

function combine(left: Fraction, right: Fraction, operator: Operator): Rational {
  const a = Rational.of(left.n, left.d);
  const b = Rational.of(right.n, right.d);
  if (operator === "+") return a.add(b);
  if (operator === "-") return a.sub(b);
  if (operator === "*") return a.mul(b);
  return a.div(b);
}

function symbol(operator: Operator): string {
  return operator === "*" ? "\\times" : operator === "/" ? "\\div" : operator;
}

export const fractionOps: Family = {
  id: "fraction-ops",
  solve(problem: Record<string, unknown>): Rational {
    return combine(problem.a as Fraction, problem.b as Fraction, problem.operator as Operator);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(2, calibration.coefficientRange[1]);
    const make = (): Fraction => ({
      n: (rng.int(0, 1) === 0 ? 1 : -1) * rng.int(1, max),
      d: rng.int(2, Math.max(2, max)),
    });
    const a = make();
    const b = make();
    const operator = rng.pick(["+", "-", "*", "/"] as const);
    const answer = combine(a, b, operator);
    const pool = [
      `Halla un denominador común para ${a.d} y ${b.d}.`,
      `Reescribe $${fractionBody(a)}$ y $${fractionBody(b)}$ con ese denominador.`,
      "Multiplica el numerador y el denominador por el mismo factor.",
      `Realiza la operación: $${latexRational(Rational.of(a.n, a.d))} ${symbol(operator)} ${latexRational(Rational.of(b.n, b.d))}$.`,
      "Simplifica la fracción resultante.",
      "Comprueba que el resultado no se puede reducir más.",
      "El resultado está en su forma irreducible.",
      `$${latexRational(answer)}$`,
    ];
    const target = rng.int(Math.max(1, calibration.steps[0]), Math.max(1, calibration.steps[1]));
    const solution = pool.slice(-Math.min(target, pool.length));
    const addedAcross = Rational.of(a.n + b.n, a.d + b.d);
    const keptDenominator = Rational.of(a.n + b.n, a.d);
    const crossed = Rational.of(a.n * b.d, a.d * b.n);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: addedAcross.toString(), display: money(addedAcross), error: "added-across" },
        {
          value: keptDenominator.toString(),
          display: money(keptDenominator),
          error: "forgot-common-denominator",
        },
        { value: crossed.toString(), display: money(crossed), error: "multiplied-across" },
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        ...perturb(answer),
      ],
    );
    return {
      family: "fraction-ops",
      level,
      type: "single_choice",
      stem: [`Calcula y simplifica: $${fractionBody(a)} ${symbol(operator)} ${fractionBody(b)}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a.n, a.d, b.n, b.d],
      stepCount: solution.length,
      problem: { a, b, operator },
    };
  },
};
