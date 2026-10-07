import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { decimalString, money, perturb } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Operator = "+" | "-" | "*";

function makeDecimal(rng: { int(min: number, max: number): number }, max: number): Rational {
  const places = rng.int(1, 2);
  const scale = 10 ** places;
  return Rational.of(rng.int(1, Math.max(1, max * scale)), scale);
}

function combine(a: Rational, b: Rational, operator: Operator): Rational {
  if (operator === "+") return a.add(b);
  if (operator === "-") return a.sub(b);
  return a.mul(b);
}

function symbol(operator: Operator): string {
  return operator === "*" ? "\\times" : operator;
}

export const decimalOps: Family = {
  id: "decimal-ops",
  solve(problem: Record<string, unknown>): Rational {
    return combine(
      Rational.parse(String(problem.a)),
      Rational.parse(String(problem.b)),
      problem.operator as Operator,
    );
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(1, calibration.coefficientRange[1]);
    const a = makeDecimal(rng, max);
    const b = makeDecimal(rng, max);
    const operator = rng.pick(["+", "-", "*"] as const);
    const answer = combine(a, b, operator);
    const pool = [
      `Align the decimal points of ${decimalString(a)} and ${decimalString(b)}.`,
      "Write both numbers with the same number of decimal places.",
      "Operate as if they were whole numbers.",
      `Multiply $${decimalString(a)} ${symbol(operator)} ${decimalString(b)}$.`,
      "Count the decimal places in the factors.",
      "Place the decimal point in the result.",
      "The result is:",
      `$${decimalString(answer)}$`,
    ];
    const target = rng.int(Math.max(1, calibration.steps[0]), Math.max(1, calibration.steps[1]));
    const solution = pool.slice(-Math.min(target, pool.length));
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: `$${decimalString(answer)}$`, error: "none" },
      [
        {
          value: answer.mul(Rational.of(10)).toString(),
          display: `$${decimalString(answer.mul(Rational.of(10)))}$`,
          error: "decimal-place-error",
        },
        {
          value: answer.neg().toString(),
          display: `$${decimalString(answer.neg())}$`,
          error: "sign-error",
        },
        {
          value: answer.add(Rational.of(1, 10)).toString(),
          display: `$${decimalString(answer.add(Rational.of(1, 10)))}$`,
          error: "off-by-one-tenth",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "decimal-ops",
      level,
      type: "single_choice",
      stem: [`$${decimalString(a)} ${symbol(operator)} ${decimalString(b)}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a.toNumber(), b.toNumber()],
      stepCount: solution.length,
      problem: { a: a.toString(), b: b.toString(), operator },
    };
  },
};
