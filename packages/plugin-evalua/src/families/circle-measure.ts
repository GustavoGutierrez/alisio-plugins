import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { piChoice, piMath, piText } from "./exact.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "circumference"
  | "area"
  | "radius-from-circumference"
  | "radius-from-area"
  | "semicircle-area"
  | "ring-area";

const UNITS = ["cm", "m"] as const;

/** Circumference and area of circles in exact multiples of π, and the radius back (EBC 6-7). */
export const circleMeasure: Family = {
  id: "circle-measure",
  solve(problem: Record<string, unknown>): Rational | string {
    const r = Rational.parse(String(problem.radius));
    const inner = Number(problem.inner ?? 0);
    switch (problem.variant as Variant) {
      case "circumference":
        return piText(r.mul(Rational.of(2)));
      case "area":
        return piText(r.mul(r));
      case "radius-from-circumference":
      case "radius-from-area":
        return r;
      case "semicircle-area":
        return piText(r.mul(r).div(Rational.of(2)));
      default:
        return piText(r.mul(r).sub(Rational.of(inner * inner)));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["circumference", "area"],
        ["circumference", "area", "radius-from-circumference"],
        ["area", "radius-from-circumference", "radius-from-area", "semicircle-area"],
        ["radius-from-area", "semicircle-area", "ring-area", "area"],
      ]),
    );
    const family = "circle-measure";
    const unit = rng.pick(UNITS);
    const high = levelHigh(calibration, [10, 15, 20, 30][index] ?? 10, 3);
    // From intermedio on, half the circles give the diameter; an odd one keeps r a fraction.
    const byDiameter =
      index >= 1 &&
      (variant === "circumference" || variant === "area" || variant === "semicircle-area")
        ? rng.int(0, 1) === 0
        : false;
    const diameter = rng.int(2, Math.min(2 * high, Math.max(4, high)));
    const radius = byDiameter ? Rational.of(diameter, 2) : Rational.of(rng.int(1, high));
    const shownValue = byDiameter ? diameter : Number(radius.n);
    const two = Rational.of(2);
    const r2 = radius.mul(radius);
    const figure = (value: number | string, half = false): FigureSpec => ({
      kind: "circle",
      params: { show: byDiameter ? "diameter" : "radius", value, unit, ...(half ? { half } : {}) },
    });
    const given = byDiameter ? `diámetro $${diameter}$ ${unit}` : `radio $${shownValue}$ ${unit}`;

    if (variant === "circumference" || variant === "area" || variant === "semicircle-area") {
      const area = variant !== "circumference";
      const half = variant === "semicircle-area";
      const answer = half ? r2.div(two) : area ? r2 : radius.mul(two);
      const distractors: OptionCandidate[] = half
        ? [
            piChoice(r2, "forgot-to-halve"),
            piChoice(radius, "used-the-arc-length"),
            piChoice(r2.mul(two), "squared-the-diameter-and-halved"),
            numberChoice(answer, "forgot-pi"),
          ]
        : area
          ? [
              piChoice(radius.mul(two), "used-the-circumference"),
              piChoice(r2.mul(Rational.of(4)), "squared-the-diameter"),
              piChoice(radius, "forgot-to-square"),
              numberChoice(r2, "forgot-pi"),
              piChoice(r2.mul(two), "doubled-the-area"),
            ]
          : [
              piChoice(radius, "used-the-radius-as-diameter"),
              piChoice(radius.mul(Rational.of(4)), "doubled-the-diameter"),
              numberChoice(radius.mul(two), "forgot-pi"),
              piChoice(r2, "used-the-area-formula"),
            ];
      const shape = half ? "semicírculo" : "círculo";
      const question = area
        ? `¿Cuál es el área de un ${shape} de ${given}? Da la respuesta en términos de $\\pi$.`
        : `¿Cuál es la longitud de la circunferencia de ${given}? Da la respuesta en términos de $\\pi$.`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, question, ""), { figure: figure(shownValue, half) }],
        correct: piChoice(answer, "none"),
        distractors,
        pool: [
          byDiameter
            ? `El radio es la mitad del diámetro: $r = ${math(radius).slice(1, -1)}$.`
            : `El radio es $r = ${shownValue}$.`,
          area ? "El área del círculo es $A = \\pi r^2$." : "La longitud es $C = 2\\pi r$.",
          area
            ? `$r^2 = ${math(r2).slice(1, -1)}$`
            : `$C = 2 \\cdot ${math(radius).slice(1, -1)} \\cdot \\pi$`,
          ...(half ? ["El semicírculo es la mitad del círculo."] : []),
          `La respuesta exacta (en ${area ? `${unit}²` : unit}):`,
          piMath(answer),
        ],
        numericValues: [shownValue],
        problem: { variant, radius: radius.toString() },
        fallback: "none",
      });
    }

    if (variant === "radius-from-circumference" || variant === "radius-from-area") {
      const fromArea = variant === "radius-from-area";
      const r = Number(radius.n);
      const known = fromArea ? r2 : radius.mul(two);
      const distractors = fromArea
        ? [
            numberChoice(r2, "forgot-the-square-root"),
            numberChoice(2 * r, "gave-the-diameter"),
            numberChoice(
              r2.isInteger() && Number(r2.n) % 2 === 0 ? Number(r2.n) / 2 : r + 1,
              "halved-instead",
            ),
          ]
        : [
            numberChoice(2 * r, "gave-the-diameter"),
            numberChoice(4 * r, "doubled-instead-of-halving"),
            piChoice(radius, "kept-pi"),
          ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            fromArea
              ? `Un círculo tiene área ${piMath(known)} ${unit}². ¿Cuánto mide su radio?`
              : `Una circunferencia mide ${piMath(known)} ${unit}. ¿Cuánto mide su radio?`,
            "",
          ),
          { figure: figure("?") },
        ],
        correct: numberChoice(radius, "none"),
        distractors,
        pool: [
          fromArea ? "El área es $A = \\pi r^2$." : "La longitud es $C = 2\\pi r$.",
          fromArea
            ? `$\\pi r^2 = ${piMath(known).slice(1, -1)}$`
            : `$2\\pi r = ${piMath(known).slice(1, -1)}$`,
          fromArea ? `$r^2 = ${Number(r2.n)}$` : `$r = ${Number(known.n)} \\div 2$`,
          fromArea ? `$r = \\sqrt{${Number(r2.n)}}$` : "Divide entre $2\\pi$.",
          `El radio mide (en ${unit}):`,
          math(radius),
        ],
        numericValues: [r],
        problem: { variant, radius: radius.toString() },
        fallback: "natural",
      });
    }

    // A ring (corona circular): the area between two concentric circles.
    const outer = rng.int(3, Math.max(4, high));
    const inner = rng.int(1, outer - 1);
    const answer = Rational.of(outer * outer - inner * inner);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        prompt(
          rng,
          prompts,
          `Una corona circular está entre dos círculos con el mismo centro, de radios $${outer}$ ${unit} y $${inner}$ ${unit}. ¿Cuál es su área en términos de $\\pi$?`,
          "",
        ),
      ],
      correct: piChoice(answer, "none"),
      distractors: [
        piChoice(Rational.of((outer - inner) ** 2), "subtracted-the-radii-first"),
        piChoice(Rational.of(outer * outer + inner * inner), "added-the-areas"),
        piChoice(Rational.of(2 * (outer - inner)), "used-the-circumference"),
        piChoice(Rational.of(outer * outer), "ignored-the-hole"),
      ],
      pool: [
        "El área de la corona es el área grande menos el área pequeña.",
        `Área grande: $\\pi \\cdot ${outer}^2 = ${outer * outer}\\pi$`,
        `Área pequeña: $\\pi \\cdot ${inner}^2 = ${inner * inner}\\pi$`,
        `$${outer * outer}\\pi - ${inner * inner}\\pi$`,
        `El área es (en ${unit}²):`,
        piMath(answer),
      ],
      numericValues: [outer, inner],
      problem: { variant, radius: String(outer), inner },
      fallback: "none",
    });
  },
};
