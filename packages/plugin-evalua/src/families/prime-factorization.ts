import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, primeFactors } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function factorsText(value: number): string {
  const factors = primeFactors(value);
  return factors.length === 0 ? "1" : factors.join(" \\cdot ");
}

export const primeFactorization: Family = {
  id: "prime-factorization",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.n) / Number(problem.p));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const primes = [2, 3, 5, 7, 11, 13].filter((prime) => prime <= max / 2);
    const p = rng.pick(primes.length > 0 ? primes : [2]);
    const q = rng.int(2, Math.max(2, Math.floor(max / p)));
    const n = p * q;
    const answer = Rational.of(q);
    const pool = [
      `$${n} = ${factorsText(n)}$`,
      `The known prime is $${p}$.`,
      `$${n} \\div ${p} = ${q}$`,
      `$${q} = ${factorsText(q)}$`,
      `Check: $${p} \\times ${q} = ${n}$.`,
      `The missing factor is ${q}.`,
      `The complete factorization is $${n} = ${factorsText(n)}$.`,
      `$${n} = ${p} \\times ${q}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: Rational.of(p).toString(),
          display: money(Rational.of(p)),
          error: "used-known-factor",
        },
        {
          value: Rational.of(n - p).toString(),
          display: money(Rational.of(n - p)),
          error: "subtracted",
        },
        {
          value: Rational.of(n + 1).toString(),
          display: money(Rational.of(n + 1)),
          error: "off-by-one",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "prime-factorization",
      level,
      type: "single_choice",
      stem: [`Completa la factorización prima: $${n} = ${p} \\times \\square$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [n, p],
      stepCount: solution.length,
      problem: { n, p },
    };
  },
};
