import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, positiveValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Mode = "power" | "root";

export const powersRoots: Family = {
  id: "powers-roots",
  solve(problem: Record<string, unknown>): Rational {
    if (problem.mode === "root") {
      return Rational.of(Math.round(Math.sqrt(Number(problem.radicand))));
    }
    return Rational.of(Number(problem.base)).pow(Number(problem.exponent));
  },
  generate({ rng, level, calibration }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const mode: Mode = rng.int(0, 1) === 0 ? "power" : "root";
    if (mode === "power") {
      const base = positiveValue(rng, calibration.coefficientRange);
      const exponent = rng.int(2, Math.max(2, Math.min(4, max)));
      const answer = Rational.of(base).pow(exponent);
      const pool = [
        `A power is a repeated product.`,
        `$${base}^{${exponent}}$ means ${exponent} factors of ${base}.`,
        `$${Array.from({ length: exponent }, () => base).join(" \\cdot ")}$`,
        `Multiply step by step.`,
        `$${base}^{${exponent}} = ${answer.toString()}$`,
        `Check the number of factors.`,
        `The result is positive for an even exponent.`,
        `$${answer.toString()}$`,
      ];
      const solution = pooled(pool, rng, calibration);
      const options = assembleOptions(
        rng,
        { value: answer.toString(), display: money(answer), error: "none" },
        [
          {
            value: Rational.of(base * exponent).toString(),
            display: money(Rational.of(base * exponent)),
            error: "multiplied-base-by-exponent",
          },
          {
            value: Rational.of(base + exponent).toString(),
            display: money(Rational.of(base + exponent)),
            error: "added-base-and-exponent",
          },
          {
            value: Rational.of(base)
              .pow(exponent - 1)
              .toString(),
            display: money(Rational.of(base).pow(exponent - 1)),
            error: "one-factor-short",
          },
          ...perturb(answer),
        ],
      );
      return {
        family: "powers-roots",
        level,
        type: "single_choice",
        stem: [`$${base}^{${exponent}}$`],
        options,
        answer: { canonical: answer.toString(), display: money(answer) },
        solution,
        numericValues: [base, exponent],
        stepCount: solution.length,
        problem: { mode, base, exponent },
      };
    }
    const root = rng.int(2, Math.max(2, Math.floor(Math.sqrt(max))));
    const radicand = root * root;
    const answer = Rational.of(root);
    const pool = [
      `We look for a number whose square is ${radicand}.`,
      `Try small squares: $2^2=4$, $3^2=9$, ...`,
      `$${root}^2 = ${radicand}$`,
      `So the square root is ${root}.`,
      `Check: $${root} \\times ${root} = ${radicand}$.`,
      `The square root is exact.`,
      `A square root asks for the side of a square of area ${radicand}.`,
      `$${answer.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: Rational.of(radicand, 2).toString(),
          display: money(Rational.of(radicand, 2)),
          error: "halved-the-number",
        },
        {
          value: Rational.of(root + 1).toString(),
          display: money(Rational.of(root + 1)),
          error: "off-by-one",
        },
        {
          value: Rational.of(root - 1).toString(),
          display: money(Rational.of(root - 1)),
          error: "off-by-one",
        },
        ...perturb(answer),
      ],
    );
    return {
      family: "powers-roots",
      level,
      type: "single_choice",
      stem: [`$\\sqrt{${radicand}}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [radicand],
      stepCount: solution.length,
      problem: { mode, radicand },
    };
  },
};
