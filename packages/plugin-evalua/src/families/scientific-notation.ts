import { Rational } from "../math/rational.js";
import { decimalMath } from "./exact.js";
import { finishDraft, levelIndex, textChoice, thousands, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { decimalString, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "to-scientific" | "to-standard" | "multiply" | "divide";

const TEN = Rational.of(10);

/** `10^exponent` for any integer exponent, exact. */
const power = (exponent: number): Rational =>
  exponent >= 0 ? TEN.pow(exponent) : TEN.pow(-exponent).inv();

/** `tenths/10 · 10^exponent`, the value of a mantissa written with one decimal. */
export const sciValue = (tenths: number, exponent: number): Rational =>
  Rational.of(tenths, 10).mul(power(exponent));

/** Splits a positive value into `mantissa · 10^exponent` with `1 <= mantissa < 10`. */
export function normalize(value: Rational): { mantissa: Rational; exponent: number } {
  let mantissa = value.abs();
  let exponent = 0;
  if (mantissa.isZero()) return { mantissa, exponent };
  while (mantissa.compare(TEN) >= 0) {
    mantissa = mantissa.div(TEN);
    exponent += 1;
  }
  while (mantissa.compare(Rational.one) < 0) {
    mantissa = mantissa.mul(TEN);
    exponent -= 1;
  }
  return { mantissa, exponent };
}

/** Canonical scientific text, `4.5e7`, shared by every representation of the same value. */
export function sciText(value: Rational): string {
  const { mantissa, exponent } = normalize(value);
  return `${decimalString(mantissa)}e${exponent}`;
}

/** `$4{,}5 \times 10^{7}$`, always normalized. */
export function sciMath(value: Rational): string {
  const { mantissa, exponent } = normalize(value);
  return `$${decimalString(mantissa).replace(".", "{,}")} \\times 10^{${exponent}}$`;
}

const sciChoice = (value: Rational, error: string): OptionCandidate =>
  textChoice(sciText(value), error, sciMath(value));

/** A positive terminating value written out: thousands with dots, decimals with a comma. */
export function standardMath(value: Rational): string {
  return value.isInteger() ? `$${thousands(Number(value.n))}$` : decimalMath(value);
}

/** Writing numbers in scientific notation, back to standard form, and multiplying or dividing. */
export const scientificNotation: Family = {
  id: "scientific-notation",
  solve(problem: Record<string, unknown>): Rational | string {
    const first = sciValue(Number(problem.tenths), Number(problem.exponent));
    switch (problem.variant as Variant) {
      case "to-scientific":
        return sciText(first);
      case "to-standard":
        return first;
      case "multiply":
        return sciText(first.mul(sciValue(Number(problem.tenths2), Number(problem.exponent2))));
      default:
        return sciText(first.div(sciValue(Number(problem.tenths2), Number(problem.exponent2))));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["to-scientific", "to-standard"],
        ["to-scientific", "to-standard"],
        ["to-scientific", "to-standard", "multiply"],
        ["multiply", "divide", "to-scientific"],
      ]),
    );
    const family = "scientific-notation";
    // A mantissa with one decimal (1,1 to 9,9) and no trailing zero; basico uses whole digits.
    const tenths = index === 0 ? rng.int(1, 9) * 10 : rng.int(11, 99);
    const mantissaTenths = tenths % 10 === 0 && index > 0 ? tenths + 1 : tenths;
    const small = index >= 1 && rng.int(0, 1) === 0;
    const exponent = small ? -rng.int(2, index >= 2 ? 6 : 4) : rng.int(3, index >= 2 ? 9 : 6);

    if (variant === "to-scientific" || variant === "to-standard") {
      const value = sciValue(mantissaTenths, exponent);
      const { mantissa } = normalize(value);
      const toScientific = variant === "to-scientific";
      const shifted = (by: number) => value.mul(power(by));
      const make = (candidate: Rational, error: string): OptionCandidate =>
        toScientific
          ? sciChoice(candidate, error)
          : { value: candidate.toString(), display: standardMath(candidate), error };
      const correct = make(value, "none");
      const distractors = [
        make(shifted(1), "miscounted-the-places"),
        make(shifted(-1), "miscounted-the-places"),
        make(sciValue(mantissaTenths, -exponent), "flipped-the-exponent-sign"),
        make(shifted(2), "moved-the-comma-twice"),
      ];
      const counted = Math.abs(exponent);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            toScientific
              ? "Escribe en notación científica: {expr}"
              : "Escribe en forma decimal (estándar): {expr}",
            toScientific ? standardMath(value) : sciMath(value),
          ),
        ],
        correct,
        distractors,
        pool: [
          "En notación científica la mantisa está entre $1$ y $10$.",
          `La mantisa es $${decimalString(mantissa).replace(".", "{,}")}$.`,
          exponent > 0
            ? `La coma se mueve $${counted}$ lugares: el exponente es $${exponent}$.`
            : `La coma se mueve $${counted}$ lugares hacia la derecha: el exponente es $${exponent}$.`,
          exponent > 0
            ? "Un exponente positivo indica un número grande."
            : "Un exponente negativo indica un número menor que $1$.",
          "El número es:",
          toScientific ? sciMath(value) : standardMath(value),
        ],
        numericValues: [exponent],
        problem: { variant, tenths: mantissaTenths, exponent },
        fallback: "none",
      });
    }

    // Products and quotients of two numbers in scientific notation, with whole-digit mantissas.
    const multiply = variant === "multiply";
    const p = rng.int(2, 9);
    const q = rng.int(2, 9);
    const m = rng.int(-6, 9);
    let n = rng.int(-6, 9);
    if (n === 0) n = 3;
    // For a quotient the first mantissa is p·q, so (p·q) / q = p stays exact.
    const firstTenths = multiply ? p * 10 : p * q * 10;
    const first = sciValue(firstTenths, m);
    const second = sciValue(q * 10, n);
    const answer = multiply ? first.mul(second) : first.div(second);
    const { exponent: resultExponent, mantissa } = normalize(answer);
    const raw = multiply ? p * q : p;
    const naiveExponent = multiply ? m + n : m - n;
    const wrongExponent = multiply ? m * n : m + n;
    const distractors = [
      sciChoice(
        Rational.of(raw).mul(power(wrongExponent)),
        multiply ? "multiplied-the-exponents" : "added-the-exponents",
      ),
      sciChoice(
        Rational.of(multiply ? p + q : Math.max(1, p * q - q)).mul(power(naiveExponent)),
        multiply ? "added-the-mantissas" : "subtracted-the-mantissas",
      ),
      sciChoice(answer.mul(TEN), "normalized-the-wrong-way"),
      sciChoice(answer.div(TEN), "normalized-the-wrong-way"),
      sciChoice(answer.mul(power(2)), "miscounted-the-places"),
    ];
    const sign = (value: number) => (value < 0 ? `(${value})` : `${value}`);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        prompt(
          rng,
          prompts,
          "Calcula y escribe en notación científica: {expr}",
          multiply
            ? `$(${p} \\times 10^{${m}}) \\cdot (${q} \\times 10^{${n}})$`
            : `$\\dfrac{${p * q} \\times 10^{${m}}}{${q} \\times 10^{${n}}}$`,
        ),
      ],
      correct: sciChoice(answer, "none"),
      distractors,
      pool: [
        multiply
          ? "Multiplica las mantisas y suma los exponentes."
          : "Divide las mantisas y resta los exponentes.",
        multiply ? `$${p} \\cdot ${q} = ${raw}$` : `$${p * q} \\div ${q} = ${raw}$`,
        multiply
          ? `$${m} + ${sign(n)} = ${naiveExponent}$`
          : `$${m} - ${sign(n)} = ${naiveExponent}$`,
        `Ajusta la mantisa entre $1$ y $10$: $${decimalString(mantissa).replace(".", "{,}")} \\times 10^{${resultExponent}}$.`,
        "El resultado es:",
        sciMath(answer),
      ],
      numericValues: [m, n],
      problem: {
        variant,
        tenths: firstTenths,
        exponent: m,
        tenths2: q * 10,
        exponent2: n,
      },
      fallback: "none",
    });
  },
};
