import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { linearText, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Relation = "<" | ">" | "<=" | ">=";

const flip = (relation: Relation): Relation =>
  relation === "<" ? ">" : relation === ">" ? "<" : relation === "<=" ? ">=" : "<=";

const latexRelation = (relation: Relation): string =>
  relation === "<=" ? "\\le" : relation === ">=" ? "\\ge" : relation;

export const linearInequality: Family = {
  id: "linear-inequality",
  solve(problem: Record<string, unknown>): string {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    const relation = problem.relation as Relation;
    const boundary = Rational.of(c - b, a);
    const effective = a > 0 ? relation : flip(relation);
    return `x${effective}${boundary.toString()}`;
  },
  generate({ rng, level, calibration }): ItemDraft {
    const a = rangeValue(rng, calibration.coefficientRange);
    const b = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const c = rangeValue(rng, calibration.coefficientRange, { allowZero: true });
    const relation = rng.pick(["<", ">", "<=", ">="] as const);
    const boundary = Rational.of(c - b, a);
    const effective = a > 0 ? relation : flip(relation);
    const canonical = `x${effective}${boundary.toString()}`;
    const pool = [
      `Solve like an equation first: $${linearText(a, b)} = ${c}$.`,
      `$${linearText(a, b)} ${latexRelation(relation)} ${c}$`,
      `$${a}x ${latexRelation(relation)} ${c - b}$`,
      a > 0
        ? `The coefficient of x is positive, so the relation does not change.`
        : `Dividing by a negative number flips the relation.`,
      `Divide both sides by ${a}.`,
      `The boundary value is $${latexRational(boundary)}$.`,
      `Check a value on each side of the boundary.`,
      `$${latexRelation(effective)} ${latexRational(boundary)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      {
        value: canonical,
        display: `$x ${latexRelation(effective)} ${latexRational(boundary)}$`,
        error: "none",
      },
      [
        {
          value: `x${flip(effective)}${boundary.toString()}`,
          display: `$x ${latexRelation(flip(effective))} ${latexRational(boundary)}$`,
          error: "forgot-to-flip",
        },
        {
          value: `x${effective}${boundary.add(Rational.one).toString()}`,
          display: `$x ${latexRelation(effective)} ${latexRational(boundary.add(Rational.one))}$`,
          error: "off-by-one",
        },
        {
          value: `x${effective}${boundary.neg().toString()}`,
          display: `$x ${latexRelation(effective)} ${latexRational(boundary.neg())}$`,
          error: "sign-error",
        },
        {
          value: `x=${boundary.toString()}`,
          display: `$x = ${latexRational(boundary)}$`,
          error: "used-equality",
        },
      ],
    );
    return {
      family: "linear-inequality",
      level,
      type: "single_choice",
      stem: [`Resuelve la inecuación: $${linearText(a, b)} ${latexRelation(relation)} ${c}$`],
      options,
      answer: {
        canonical,
        display: `$x ${latexRelation(effective)} ${latexRational(boundary)}$`,
      },
      solution,
      numericValues: [a, b, c],
      stepCount: solution.length,
      problem: { a, b, c, relation },
    };
  },
};
