import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { gcdOf, money, perturb, primeFactors } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function factorText(value: number): string {
  const factors = primeFactors(value);
  if (factors.length === 0) return "1";
  const counts = new Map<number, number>();
  for (const factor of factors) counts.set(factor, (counts.get(factor) ?? 0) + 1);
  return [...counts.entries()]
    .map(([prime, exponent]) => (exponent === 1 ? `${prime}` : `${prime}^{${exponent}}`))
    .join(" \\cdot ");
}

function fraction(numerator: number, denominator: number): string {
  const sign = numerator < 0 ? "-" : "";
  return `${sign}\\dfrac{${Math.abs(numerator)}}{${denominator}}`;
}

interface Problem {
  n: number;
  d: number;
}

export const fractionSimplify: Family = {
  id: "fraction-simplify",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.n), Number(problem.d));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(2, calibration.coefficientRange[1]);
    const factor = rng.int(2, Math.max(2, Math.floor(max / 2)));
    const limit = Math.max(2, Math.floor(max / factor));
    const baseNumerator = rng.int(1, limit);
    const baseDenominator = rng.int(2, Math.max(2, limit));
    const sign = rng.int(0, 1) === 0 ? 1 : -1;
    const n = sign * factor * baseNumerator;
    const d = factor * baseDenominator;
    const common = gcdOf(n, d);
    const answer = Rational.of(n, d);
    const reducedNumerator = n / common;
    const reducedDenominator = d / common;
    const pool = [
      `$${n} = ${factorText(n)}$`,
      `$${d} = ${factorText(d)}$`,
      `$\\gcd(${n}, ${d}) = ${common}$`,
      `Divide el numerador entre ${common}: $${n} \\div ${common} = ${reducedNumerator}$`,
      `Divide el denominador entre ${common}: $${d} \\div ${common} = ${reducedDenominator}$`,
      `Comprueba: $\\gcd(${reducedNumerator}, ${reducedDenominator}) = 1$`,
      "La fracción está en su forma irreducible.",
      `$${latexRational(answer)}$`,
    ];
    const target = rng.int(Math.max(1, calibration.steps[0]), Math.max(1, calibration.steps[1]));
    const solution = pool.slice(-Math.min(target, pool.length));
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: Rational.of(n, reducedDenominator).toString(),
          display: money(Rational.of(n, reducedDenominator)),
          error: "forgot-the-numerator",
        },
        {
          value: Rational.of(reducedNumerator, d).toString(),
          display: money(Rational.of(reducedNumerator, d)),
          error: "forgot-the-denominator",
        },
        {
          value: answer.neg().toString(),
          display: money(answer.neg()),
          error: "sign-error",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "fraction-simplify",
      level,
      type: "single_choice",
      stem: [`Simplifica la fracción $${fraction(n, d)}$ hasta su forma irreducible.`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [n, d],
      stepCount: solution.length,
      problem: { n, d } satisfies Problem,
    };
  },
};
