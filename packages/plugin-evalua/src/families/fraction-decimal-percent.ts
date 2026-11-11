import { Rational } from "../math/rational.js";
import { finishDraft, fractionMath, levelIndex, shownChoice } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { decimalString, gcdOf, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Form = "fraction" | "decimal" | "percent";

/** Denominators each level draws; all of them give a terminating decimal. */
const DENOMINATORS = [
  [2, 5, 10],
  [2, 4, 5, 10, 20, 25, 100],
  [2, 4, 5, 8, 10, 20, 25, 50, 100],
  [4, 8, 20, 25, 40, 50, 100],
];

const FORM_NAMES: Record<Form, string> = {
  fraction: "una fracción simplificada",
  decimal: "un número decimal",
  percent: "un porcentaje",
};

const decimalMath = (value: Rational): string => `$${decimalString(value).replace(".", "{,}")}$`;
const percentMath = (value: Rational): string =>
  `$${decimalString(value.mul(Rational.of(100))).replace(".", "{,}")}\\%$`;
const reducedMath = (value: Rational): string =>
  value.isInteger() ? `$${value.toString()}$` : fractionMath(Number(value.n), Number(value.d));

function shown(value: Rational, form: Form): string {
  if (form === "decimal") return decimalMath(value);
  if (form === "percent") return percentMath(value);
  return reducedMath(value);
}

/** The digits a student reads in a decimal or percent (0,75 -> 75), the calibrated number. */
function digitsOf(value: Rational): number {
  return Number(decimalString(value).replace(".", "").replace(/^0+/, "") || "0");
}

const choice = (value: Rational, form: Form, error: string): OptionCandidate | undefined =>
  value.sign() > 0 ? shownChoice(value, shown(value, form), error) : undefined;

/** Converting between fractions, decimals and percentages (DBA 4 #2-3). */
export const fractionDecimalPercent: Family = {
  id: "fraction-decimal-percent",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.numerator), Number(problem.denominator));
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const denominator = rng.pick(DENOMINATORS[index] ?? [10]);
    const top = index === 3 ? denominator + Math.floor(denominator / 2) : denominator - 1;
    let numerator = rng.int(1, Math.max(1, top));
    if (numerator === denominator) numerator -= 1;
    const value = Rational.of(numerator, denominator);
    const forms: Form[] = ["fraction", "decimal", "percent"];
    const usable = index === 0 ? forms.slice(0, 2) : forms;
    const from = rng.pick(usable);
    const to = rng.pick(usable.filter((form) => form !== from));
    const given = from === "fraction" ? fractionMath(numerator, denominator) : shown(value, from);
    const tenth = Rational.of(1, 10);
    const ten = Rational.of(10);
    const termsDecimal = Rational.parse(`${numerator}${denominator}`).div(
      Rational.of(10).pow(String(denominator).length),
    );
    const candidates = [
      choice(value.mul(ten), to, "place-value-slip"),
      choice(value.mul(tenth), to, "place-value-slip"),
      choice(Rational.one.sub(value), to, "found-the-complement"),
      to === "percent"
        ? choice(value.div(Rational.of(100)), to, "forgot-to-multiply-by-100")
        : undefined,
      from === "percent"
        ? choice(value.mul(Rational.of(100)), to, "forgot-to-divide-by-100")
        : undefined,
      from === "fraction" ? choice(termsDecimal, to, "wrote-the-terms-as-digits") : undefined,
      choice(value.inv(), to, "inverted"),
    ].filter((entry): entry is OptionCandidate => entry !== undefined);
    const factor = gcdOf(numerator, denominator);
    const working =
      to === "percent"
        ? [`Multiplica por $100$: ${shown(value, "decimal")} $\\times 100$.`]
        : from === "percent"
          ? ["Un porcentaje es una fracción con denominador $100$.", `Divide entre $100$.`]
          : to === "decimal"
            ? [`Divide el numerador entre el denominador: $${numerator} \\div ${denominator}$.`]
            : [
                `Escribe el decimal como fracción con denominador $10$, $100$ o $1000$.`,
                `Simplifica dividiendo entre $${factor}$.`,
              ];
    return finishDraft({
      family: "fraction-decimal-percent",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, `Escribe {expr} como ${FORM_NAMES[to]}.`, given)],
      correct: shownChoice(value, shown(value, to), "none"),
      distractors: candidates,
      pool: [
        "Una fracción, un decimal y un porcentaje pueden nombrar la misma cantidad.",
        `Cantidad dada: ${given}.`,
        ...working,
        "Comprueba que las dos expresiones valgan lo mismo.",
        "El resultado es:",
        shown(value, to),
      ],
      numericValues:
        from === "fraction"
          ? [numerator, denominator]
          : [digitsOf(from === "percent" ? value.mul(Rational.of(100)) : value)],
      problem: { from, to, numerator, denominator },
      fallback: "none",
    });
  },
};
