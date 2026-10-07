import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { boundedRange, money, perturb, pickSteps, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Op = "+" | "-" | "*";

interface Problem {
  numbers: number[];
  operators: Op[];
}

function evaluate(problem: Problem): { value: Rational; lines: string[] } {
  const values = problem.numbers.map((value) => Rational.of(value));
  const operators = [...problem.operators];
  const lines: string[] = [];
  let index = 0;
  while (index < operators.length) {
    if (operators[index] === "*") {
      const left = values[index];
      const right = values[index + 1];
      if (left === undefined || right === undefined) break;
      const product = left.mul(right);
      lines.push(
        `$${latexRational(left)} \\times ${latexRational(right)} = ${latexRational(product)}$`,
      );
      values.splice(index, 2, product);
      operators.splice(index, 1);
    } else {
      index += 1;
    }
  }
  while (operators.length > 0) {
    const op = operators[0];
    const left = values[0];
    const right = values[1];
    if (op === undefined || left === undefined || right === undefined) break;
    const result = op === "+" ? left.add(right) : left.sub(right);
    lines.push(`$${latexRational(left)} ${op} ${latexRational(right)} = ${latexRational(result)}$`);
    values.splice(0, 2, result);
    operators.splice(0, 1);
  }
  return { value: values[0] ?? Rational.zero, lines };
}

function leftToRight(problem: Problem): Rational {
  let acc = Rational.of(problem.numbers[0] ?? 0);
  problem.operators.forEach((op, index) => {
    const value = Rational.of(problem.numbers[index + 1] ?? 0);
    if (op === "+") acc = acc.add(value);
    else if (op === "-") acc = acc.sub(value);
    else acc = acc.mul(value);
  });
  return acc;
}

function expression(problem: Problem): string {
  let text = latexRational(Rational.of(problem.numbers[0] ?? 0));
  problem.operators.forEach((op, index) => {
    const symbol = op === "*" ? "\\times" : op;
    text += ` ${symbol} ${latexRational(Rational.of(problem.numbers[index + 1] ?? 0))}`;
  });
  return `$${text}$`;
}

export const orderOfOperations: Family = {
  id: "order-of-operations",
  solve(problem: Record<string, unknown>): Rational {
    return evaluate(problem as unknown as Problem).value;
  },
  generate({ rng, level, calibration }): ItemDraft {
    const target = pickSteps(rng, calibration);
    const cheap = boundedRange(calibration.coefficientRange, 9);
    const count = target + 1;
    const numbers: number[] = [];
    for (let index = 0; index < count; index += 1) {
      numbers.push(rangeValue(rng, index === 0 ? calibration.coefficientRange : cheap));
    }
    const operators: Op[] = [];
    let usedMultiply = false;
    for (let index = 0; index < target; index += 1) {
      const canMultiply = !usedMultiply && target >= 2 && rng.int(0, 2) === 0;
      if (canMultiply) {
        operators.push("*");
        usedMultiply = true;
      } else {
        operators.push(rng.int(0, 1) === 0 ? "+" : "-");
      }
    }
    const problem: Problem = { numbers, operators };
    const { value, lines } = evaluate(problem);
    const wrongPrecedence = leftToRight(problem);
    const options = assembleOptions(
      rng,
      { value: value.toString(), display: money(value), error: "none" },
      [
        {
          value: wrongPrecedence.toString(),
          display: money(wrongPrecedence),
          error: "left-to-right",
        },
        { value: value.neg().toString(), display: money(value.neg()), error: "sign-error" },
        {
          value: value.add(Rational.one).toString(),
          display: money(value.add(Rational.one)),
          error: "off-by-one",
        },
        {
          value: value.mul(Rational.of(2)).toString(),
          display: money(value.mul(Rational.of(2))),
          error: "double-counted",
        },
        ...perturb(value),
      ],
    );
    return {
      family: "order-of-operations",
      level,
      type: "single_choice",
      stem: [expression(problem)],
      options,
      answer: { canonical: value.toString(), display: money(value) },
      solution: lines,
      numericValues: numbers,
      stepCount: lines.length,
      problem: { numbers, operators },
    };
  },
};
