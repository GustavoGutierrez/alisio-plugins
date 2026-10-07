import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { perturb, pooled } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function mixedText(n: number, d: number): string {
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  const whole = Math.floor(value / d);
  const remainder = value % d;
  if (remainder === 0) return `${sign}${whole}`;
  if (whole === 0) return `${sign}\\dfrac{${remainder}}{${d}}`;
  return `${sign}${whole}\\ \\dfrac{${remainder}}{${d}}`;
}

export const mixedNumbers: Family = {
  id: "mixed-numbers",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.n), Number(problem.d));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(3, calibration.coefficientRange[1]);
    const d = rng.int(2, Math.max(2, Math.floor(max / 2)));
    const whole = rng.int(1, Math.max(1, Math.floor((max - (d - 1)) / d)));
    const remainder = rng.int(1, d - 1);
    const sign = rng.int(0, 1) === 0 ? 1 : -1;
    const n = sign * (whole * d + remainder);
    const answer = Rational.of(n, d);
    const pool = [
      `Divide the numerator by the denominator: $${Math.abs(n)} \\div ${d}$.`,
      `The quotient is the whole part: $${whole}$.`,
      `The remainder is $${remainder}$.`,
      `The fractional part is $\\dfrac{${remainder}}{${d}}$.`,
      `So $\\dfrac{${Math.abs(n)}}{${d}} = ${mixedText(n, d)}$.`,
      `Check: $${whole} \\cdot ${d} + ${remainder} = ${Math.abs(n)}$.`,
      `Keep the sign of the numerator.`,
      `$${mixedText(n, d)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: `$${mixedText(n, d)}$`, error: "none" },
      [
        {
          value: Rational.of(sign * whole * d + remainder, d).toString(),
          display: `$${mixedText(sign * whole * d + remainder, d)}$`,
          error: "dropped-remainder",
        },
        {
          value: Rational.of(sign * ((whole + 1) * d + remainder), d).toString(),
          display: `$${mixedText(sign * ((whole + 1) * d + remainder), d)}$`,
          error: "wrong-whole-part",
        },
        {
          value: Rational.of(sign * (whole * d + (d - remainder)), d).toString(),
          display: `$${mixedText(sign * (whole * d + (d - remainder)), d)}$`,
          error: "inverted-remainder",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "mixed-numbers",
      level,
      type: "single_choice",
      stem: [`$${sign < 0 ? "-" : ""}\\dfrac{${Math.abs(n)}}{${d}}$`],
      options,
      answer: { canonical: answer.toString(), display: `$${mixedText(n, d)}$` },
      solution,
      numericValues: [n, d],
      stepCount: solution.length,
      problem: { n, d },
    };
  },
};
