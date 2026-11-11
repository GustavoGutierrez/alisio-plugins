import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, fractionMath, levelIndex, math, numberChoice, shownChoice } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "shaded" | "unshaded" | "of-a-set";

const fractionChoice = (
  numerator: number,
  denominator: number,
  error: string,
): OptionCandidate | undefined =>
  denominator === 0
    ? undefined
    : shownChoice(Rational.of(numerator, denominator), fractionMath(numerator, denominator), error);

const SETS = [
  { whole: "canicas", part: "son azules", how: "Cuántas" },
  { whole: "estudiantes", part: "llevan gorra", how: "Cuántos" },
  { whole: "manzanas", part: "son rojas", how: "Cuántas" },
  { whole: "lápices", part: "están nuevos", how: "Cuántos" },
];

/** The largest denominator each level draws (halves to twelfths). */
const DENOMINATORS = [6, 8, 10, 12];

/** Fractions as part of a whole (shaded figures) and of a set (DBA 3 #2). */
export const fractionPart: Family = {
  id: "fraction-part",
  solve(problem: Record<string, unknown>): Rational {
    const parts = Number(problem.parts);
    const shaded = Number(problem.shaded);
    if (problem.variant === "of-a-set") return Rational.of(Number(problem.total) * shaded, parts);
    return Rational.of(problem.variant === "unshaded" ? parts - shaded : shaded, parts);
  },
  generate(context: FamilyContext): ItemDraft {
    const { rng, level, calibration, prompts } = context;
    const index = levelIndex(level);
    const variants: Variant[] =
      index === 0
        ? ["shaded"]
        : index === 1
          ? ["shaded", "unshaded", "of-a-set"]
          : ["shaded", "unshaded", "of-a-set", "of-a-set"];
    const variant = rng.pick(variants);
    const parts = rng.int(2, Math.min(DENOMINATORS[index] ?? 6, calibration.coefficientRange[1]));
    const shaded = rng.int(1, parts - 1);
    if (variant === "of-a-set") return ofASet(context, parts, shaded, index);
    const shape = rng.pick(["fraction-bar", "fraction-circle"] as const);
    const figure: FigureSpec = {
      kind: shape,
      params: shape === "fraction-bar" ? { parts, shaded, hatch: true } : { parts, shaded },
    };
    const counted = variant === "unshaded" ? parts - shaded : shaded;
    const other = parts - counted;
    const ask = variant === "unshaded" ? "no está sombreada" : "está sombreada";
    const options = [
      fractionChoice(
        other,
        parts,
        variant === "unshaded" ? "counted-the-shaded" : "counted-the-unshaded",
      ),
      fractionChoice(counted, other, "part-to-part"),
      fractionChoice(parts, counted, "inverted-the-fraction"),
      fractionChoice(counted, parts + 1, "counted-the-lines"),
      fractionChoice(counted + 1, parts, "off-by-one"),
    ].filter((option): option is OptionCandidate => option !== undefined);
    return finishDraft({
      family: "fraction-part",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, `¿Qué fracción de la figura ${ask}?`, ""), { figure }],
      correct: shownChoice(Rational.of(counted, parts), fractionMath(counted, parts), "none"),
      distractors: options,
      pool: [
        "Comprueba que todas las partes sean iguales.",
        `La figura tiene $${parts}$ partes iguales: ese es el denominador.`,
        `Hay $${counted}$ partes que ${variant === "unshaded" ? "no están sombreadas" : "están sombreadas"}: ese es el numerador.`,
        "La fracción es numerador sobre denominador.",
        `La fracción que ${ask} es:`,
        fractionMath(counted, parts),
      ],
      numericValues: [],
      problem: { variant, parts, shaded },
      fallback: "none",
    });
  },
};

function ofASet(
  { rng, level, calibration, prompts }: FamilyContext,
  parts: number,
  shaded: number,
  index: number,
): ItemDraft {
  const high = Math.max(parts * 2, Math.floor(calibration.coefficientRange[1]));
  // Intermedio keeps unit fractions (one part); later levels take several parts.
  const numerator = index === 1 ? 1 : shaded;
  const group = rng.int(2, Math.max(2, Math.min(12, Math.floor(high / parts))));
  const total = group * parts;
  const answer = group * numerator;
  const set = rng.pick(SETS);
  const instruction = prompt(
    rng,
    prompts,
    `De $${total}$ ${set.whole}, {expr} ${set.part}. ¿${set.how} ${set.part}?`,
    fractionMath(numerator, parts),
  );
  return finishDraft({
    family: "fraction-part",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: numberChoice(answer, "none"),
    distractors: [
      numberChoice(group, numerator === 1 ? "divided-by-the-numerator" : "used-one-part-only"),
      numberChoice(total - answer, "found-the-complement"),
      numberChoice(Math.abs(total - parts) || total + 1, "subtracted-the-denominator"),
      numberChoice(numerator * parts, "multiplied-the-terms"),
    ],
    pool: [
      `Divide el total en $${parts}$ grupos iguales.`,
      `$${total} \\div ${parts} = ${group}$`,
      `Toma $${numerator}$ ${numerator === 1 ? "grupo" : "grupos"}.`,
      `$${group} \\times ${numerator} = ${answer}$`,
      "La cantidad es:",
      math(answer),
    ],
    numericValues: [total, numerator, parts],
    problem: { variant: "of-a-set", parts, shaded: numerator, total },
  });
}
