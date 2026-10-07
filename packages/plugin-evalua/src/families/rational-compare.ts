import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

interface Problem {
  a: string;
  b: string;
}

export const rationalCompare: Family = {
  id: "rational-compare",
  solve(problem: Record<string, unknown>): Rational {
    const a = Rational.parse(String(problem.a));
    const b = Rational.parse(String(problem.b));
    return a.compare(b) >= 0 ? a : b;
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(2, calibration.coefficientRange[1]);
    const make = (): Rational =>
      Rational.of(
        (rng.int(0, 1) === 0 ? 1 : -1) * rangeValue(rng, calibration.coefficientRange),
        rng.int(2, Math.max(2, max)),
      );
    const a = make();
    let b = make();
    let guard = 0;
    while (a.equals(b) && guard < 10) {
      b = make();
      guard += 1;
    }
    const answer = a.compare(b) >= 0 ? a : b;
    const smaller = a.compare(b) >= 0 ? b : a;
    const pool = [
      `Write both fractions with a common denominator.`,
      `$${latexRational(a)} = \\dfrac{${a.n * b.d}}{${a.d * b.d}}$`,
      `$${latexRational(b)} = \\dfrac{${b.n * a.d}}{${b.d * a.d}}$`,
      `Compare the numerators $${a.n * b.d}$ and $${b.n * a.d}$.`,
      `The greater numerator gives the greater fraction.`,
      `Watch the sign: a negative fraction is smaller than a positive one.`,
      `The greater value is $${latexRational(answer)}$.`,
      `$${latexRational(answer)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        { value: smaller.toString(), display: money(smaller), error: "picked-the-smaller" },
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        {
          value: answer.add(smaller).toString(),
          display: money(answer.add(smaller)),
          error: "added-instead",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "rational-compare",
      level,
      type: "single_choice",
      stem: [
        `¿Cuál de los dos números es mayor? $\\max\\left(${latexRational(a)}, ${latexRational(b)}\\right)$`,
      ],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [Number(a.n), Number(a.d), Number(b.n), Number(b.d)],
      stepCount: solution.length,
      problem: { a: a.toString(), b: b.toString() } satisfies Problem,
    };
  },
};
