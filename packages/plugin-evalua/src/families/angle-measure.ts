import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "classify-figure"
  | "classify-measure"
  | "complement"
  | "supplement"
  | "around"
  | "turn";
type Kind = "agudo" | "recto" | "obtuso" | "llano";

const KINDS: readonly Kind[] = ["agudo", "recto", "obtuso", "llano"];

export function classifyAngle(degrees: number): Kind {
  if (degrees < 90) return "agudo";
  if (degrees === 90) return "recto";
  if (degrees < 180) return "obtuso";
  return "llano";
}

const TURNS = [
  { text: "un cuarto de vuelta", degrees: 90 },
  { text: "media vuelta", degrees: 180 },
  { text: "tres cuartos de vuelta", degrees: 270 },
  { text: "una vuelta completa", degrees: 360 },
];

const degreesMath = (value: number): string => `$${value}^{\\circ}$`;
const degreeChoice = (value: number, error: string): OptionCandidate => ({
  ...numberChoice(value, error),
  display: degreesMath(value),
});

/** Clear-cut angle in degrees (multiples of 5, never within 10 of a boundary) for a class. */
function angleOf(rng: FamilyContext["rng"], kind: Kind, cap: number): number {
  if (kind === "recto") return 90;
  if (kind === "llano") return 180;
  if (kind === "agudo") return rng.int(2, Math.max(2, Math.min(16, Math.floor(cap / 5)))) * 5;
  return rng.int(20, 34) * 5;
}

/** Measuring and classifying angles, complements, supplements and turns (EBC 4-5). */
export const angleMeasure: Family = {
  id: "angle-measure",
  solve(problem: Record<string, unknown>): Rational | string {
    const a = Number(problem.a);
    switch (problem.variant as Variant) {
      case "complement":
        return Rational.of(90 - a);
      case "supplement":
        return Rational.of(180 - a);
      case "around":
        return Rational.of(360 - a - Number(problem.b));
      case "turn":
        return Rational.of(a);
      default:
        return classifyAngle(a);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const cap = Math.floor(calibration.coefficientRange[1]);
    const variants = tier<Variant>(index, [
      ["classify-figure", "classify-measure"],
      ["classify-figure", "classify-measure", "complement", "turn"],
      ["classify-measure", "complement", "supplement", "around"],
      ["supplement", "around", "complement", "classify-measure"],
    ]);
    const variant = rng.pick(variants);

    if (variant === "classify-figure" || variant === "classify-measure") {
      // The measure is written in the stem, so it must fit the level range (basico: only acute).
      const allowed =
        variant === "classify-figure"
          ? KINDS
          : KINDS.filter((entry) => entry === "agudo" || cap >= (entry === "recto" ? 90 : 180));
      const kind = rng.pick(allowed);
      const a = angleOf(rng, kind, variant === "classify-figure" ? 90 : cap);
      const figure: FigureSpec = {
        kind: "angle",
        params: { degrees: a, showMeasure: variant === "classify-measure" },
      };
      const ask =
        variant === "classify-figure"
          ? "¿Qué clase de ángulo es el de la figura?"
          : `Un ángulo mide ${degreesMath(a)}. ¿Qué clase de ángulo es?`;
      const errors: Record<Kind, string> = {
        agudo: "confused-acute",
        recto: "confused-right",
        obtuso: "confused-obtuse",
        llano: "confused-straight",
      };
      return finishDraft({
        family: "angle-measure",
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, ask, ""), { figure }],
        correct: textChoice(kind, "none", `Ángulo ${kind}`),
        distractors: KINDS.filter((entry) => entry !== kind).map((entry) =>
          textChoice(entry, errors[entry], `Ángulo ${entry}`),
        ),
        pool: [
          "Un ángulo agudo mide menos de $90^{\\circ}$.",
          "Un ángulo recto mide exactamente $90^{\\circ}$.",
          "Un ángulo obtuso mide más de $90^{\\circ}$ y menos de $180^{\\circ}$.",
          "Un ángulo llano mide $180^{\\circ}$.",
          variant === "classify-figure"
            ? "Compara la abertura con la de una esquina de una hoja (un ángulo recto)."
            : `Compara ${degreesMath(a)} con $90^{\\circ}$.`,
          "El ángulo es:",
          kind,
        ],
        numericValues: variant === "classify-measure" ? [a] : [],
        problem: { variant, a },
        fallback: "none",
      });
    }

    if (variant === "turn") {
      const turn = rng.pick(TURNS);
      return finishDraft({
        family: "angle-measure",
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `¿Cuántos grados gira la manecilla de un reloj en ${turn.text}?`,
            "",
          ),
        ],
        correct: degreeChoice(turn.degrees, "none"),
        distractors: TURNS.filter((entry) => entry !== turn).map((entry) =>
          degreeChoice(entry.degrees, "confused-the-turn"),
        ),
        pool: [
          "Una vuelta completa mide $360^{\\circ}$.",
          `Calcula la parte de la vuelta: ${turn.text}.`,
          "La medida es:",
          degreesMath(turn.degrees),
        ],
        numericValues: [],
        problem: { variant, a: turn.degrees },
        fallback: "none",
      });
    }

    const total = variant === "complement" ? 90 : variant === "supplement" ? 180 : 360;
    const a =
      rng.int(
        variant === "around" ? 10 : 2,
        variant === "complement" ? 17 : variant === "supplement" ? 34 : 25,
      ) * 5;
    const b = variant === "around" ? rng.int(4, Math.max(4, Math.floor((350 - a) / 5) - 4)) * 5 : 0;
    const answer = total - a - b;
    const context =
      variant === "complement"
        ? `Dos ángulos juntos forman un ángulo recto. Uno mide ${degreesMath(a)}. ¿Cuánto mide el otro?`
        : variant === "supplement"
          ? `Dos ángulos juntos forman un ángulo llano. Uno mide ${degreesMath(a)}. ¿Cuánto mide el otro?`
          : `Tres ángulos alrededor de un punto completan una vuelta. Dos miden ${degreesMath(a)} y ${degreesMath(b)}. ¿Cuánto mide el tercero?`;
    const distractors = [
      variant === "supplement"
        ? degreeChoice(Math.abs(90 - a) || answer + 20, "used-the-right-angle")
        : degreeChoice(Math.abs(180 - a - b) || answer + 20, "used-the-straight-angle"),
      degreeChoice(
        variant === "around" ? a + b : a,
        variant === "around" ? "added-the-angles" : "copied-the-angle",
      ),
      degreeChoice(
        variant === "around" ? 360 - a : total + a,
        variant === "around" ? "forgot-one-angle" : "added-instead",
      ),
      degreeChoice(answer + 10, "subtraction-slip"),
      degreeChoice(Math.max(5, answer - 10), "subtraction-slip"),
    ];
    return finishDraft({
      family: "angle-measure",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, context, "")],
      correct: degreeChoice(answer, "none"),
      distractors,
      pool: [
        variant === "complement"
          ? "Un ángulo recto mide $90^{\\circ}$."
          : variant === "supplement"
            ? "Un ángulo llano mide $180^{\\circ}$."
            : "Una vuelta completa mide $360^{\\circ}$.",
        `Los ángulos suman ${degreesMath(total)}.`,
        variant === "around" ? `$${a} + ${b} = ${a + b}$` : `Resta el ángulo conocido del total.`,
        `$${total} - ${a + b} = ${answer}$`,
        "El ángulo mide:",
        degreesMath(answer),
      ],
      numericValues: variant === "around" ? [a, b] : [a],
      problem: { variant, a, b },
      fallback: "none",
    });
  },
};
