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
        `Una potencia es un producto repetido.`,
        `$${base}^{${exponent}}$ significa ${exponent} factores de ${base}.`,
        `$${Array.from({ length: exponent }, () => base).join(" \\cdot ")}$`,
        `Multiplica paso a paso.`,
        `$${base}^{${exponent}} = ${answer.toString()}$`,
        `Comprueba el número de factores.`,
        `El resultado es positivo si el exponente es par.`,
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
        stem: [`Calcula la potencia: $${base}^{${exponent}}$`],
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
      `Buscamos un número cuyo cuadrado sea ${radicand}.`,
      `Prueba con cuadrados pequeños: $2^2=4$, $3^2=9$, ...`,
      `$${root}^2 = ${radicand}$`,
      `Entonces la raíz cuadrada es ${root}.`,
      `Comprueba: $${root} \\times ${root} = ${radicand}$.`,
      `La raíz cuadrada es exacta.`,
      `La raíz cuadrada pide el lado de un cuadrado de área ${radicand}.`,
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
      stem: [`Calcula la raíz cuadrada: $\\sqrt{${radicand}}$`],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [radicand],
      stepCount: solution.length,
      problem: { mode, radicand },
    };
  },
};
