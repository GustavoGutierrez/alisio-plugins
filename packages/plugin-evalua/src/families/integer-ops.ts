import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { boundedRange, money, perturb, pickSteps, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Op = "+" | "-" | "*";

interface IntegerOp {
  op: Op;
  value: number;
}

function apply(acc: Rational, op: Op, value: number): Rational {
  const other = Rational.of(value);
  if (op === "+") return acc.add(other);
  if (op === "-") return acc.sub(other);
  return acc.mul(other);
}

function evaluate(start: number, ops: IntegerOp[]): Rational {
  let acc = Rational.of(start);
  for (const entry of ops) acc = apply(acc, entry.op, entry.value);
  return acc;
}

function symbol(op: Op): string {
  return op === "*" ? "\\times" : op;
}

export const integerOps: Family = {
  id: "integer-ops",
  solve(problem: Record<string, unknown>): Rational {
    const start = Number(problem.start);
    const ops = problem.ops as IntegerOp[];
    return evaluate(start, ops);
  },
  generate({ rng, level, calibration }): ItemDraft {
    const target = pickSteps(rng, calibration);
    const start = rangeValue(rng, calibration.coefficientRange);
    const cheap = boundedRange(calibration.coefficientRange, 9);
    const ops: IntegerOp[] = [];
    const numericValues = [start];
    const solution: string[] = [];
    let acc = Rational.of(start);
    for (let index = 0; index < target; index += 1) {
      const op: Op = target <= 2 && rng.int(0, 1) === 1 ? "*" : rng.int(0, 1) === 0 ? "+" : "-";
      const value =
        op === "*" ? rangeValue(rng, cheap) : rangeValue(rng, calibration.coefficientRange);
      const previous = acc;
      acc = apply(acc, op, value);
      ops.push({ op, value });
      numericValues.push(value);
      solution.push(
        `$${latexRational(previous)} ${symbol(op)} ${latexRational(Rational.of(value))} = ${latexRational(acc)}$`,
      );
    }
    const wrongLast = (() => {
      const last = ops[ops.length - 1];
      if (last === undefined) return acc.add(Rational.one);
      const swapped: Op = last.op === "*" ? "+" : last.op === "+" ? "-" : "+";
      return evaluate(
        start,
        ops.map((entry, index) =>
          index === ops.length - 1 ? { op: swapped, value: entry.value } : entry,
        ),
      );
    })();
    const options = assembleOptions(
      rng,
      { value: acc.toString(), display: money(acc), error: "none" },
      [
        { value: acc.neg().toString(), display: money(acc.neg()), error: "sign-error" },
        {
          value: acc.add(Rational.one).toString(),
          display: money(acc.add(Rational.one)),
          error: "off-by-one",
        },
        {
          value: acc.sub(Rational.one).toString(),
          display: money(acc.sub(Rational.one)),
          error: "off-by-one",
        },
        { value: wrongLast.toString(), display: money(wrongLast), error: "wrong-operation" },
        {
          value: acc.mul(Rational.of(2)).toString(),
          display: money(acc.mul(Rational.of(2))),
          error: "double-counted",
        },
        ...perturb(acc),
      ],
    );
    return {
      family: "integer-ops",
      level,
      type: "single_choice",
      stem: [
        `$${ops.map((entry, index) => `${index === 0 ? latexRational(Rational.of(start)) : ""} ${symbol(entry.op)} ${latexRational(Rational.of(entry.value))}`).join("")}$`,
      ],
      options,
      answer: { canonical: acc.toString(), display: money(acc) },
      solution,
      numericValues,
      stepCount: solution.length,
      problem: { start, ops },
    };
  },
};
