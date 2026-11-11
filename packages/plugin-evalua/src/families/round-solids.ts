import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { piChoice, piMath, piText } from "./exact.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Solid = "cylinder" | "cone" | "sphere" | "hemisphere" | "silo" | "cylinder-height";

const SOLID_NAME: Record<Solid, string> = {
  cylinder: "cilindro",
  cone: "cono",
  sphere: "esfera",
  hemisphere: "semiesfera",
  silo: "silo",
  "cylinder-height": "cilindro",
};

/** Volume as a multiple of π: `V / π` for a radius `r` and height `h`. */
export function volumeOverPi(solid: Solid, r: number, h: number): Rational {
  const r2 = Rational.of(r * r);
  const r3 = Rational.of(r * r * r);
  switch (solid) {
    case "cylinder":
    case "cylinder-height":
      return r2.mul(Rational.of(h));
    case "cone":
      return r2.mul(Rational.of(h)).div(Rational.of(3));
    case "sphere":
      return r3.mul(Rational.of(4, 3));
    case "hemisphere":
      return r3.mul(Rational.of(2, 3));
    default:
      // A cylinder topped by a hemisphere of the same radius.
      return r2.mul(Rational.of(h)).add(r3.mul(Rational.of(2, 3)));
  }
}

/** Volumes of cylinders, cones and spheres in exact multiples of π (DBA 9 #4). */
export const roundSolids: Family = {
  id: "round-solids",
  solve(problem: Record<string, unknown>): Rational | string {
    const solid = problem.solid as Solid;
    const r = Number(problem.r);
    const h = Number(problem.h);
    if (solid === "cylinder-height") return Rational.of(h);
    return piText(volumeOverPi(solid, r, h));
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const solid = rng.pick(
      tier<Solid>(index, [
        ["cylinder", "cone"],
        ["cylinder", "cone", "sphere"],
        ["cone", "sphere", "hemisphere", "cylinder"],
        ["sphere", "silo", "cylinder-height", "cone"],
      ]),
    );
    const family = "round-solids";
    const unit = rng.pick(["cm", "m"]);
    const high = levelHigh(calibration, [8, 10, 12, 15][index] ?? 8, 3);
    const r = rng.int(1, Math.min(high, solid === "sphere" || solid === "hemisphere" ? 9 : high));
    // A cone's height is a multiple of 3 when r² is not, so V / π stays whole for the youngest.
    let h = rng.int(2, Math.max(3, 2 * high));
    if (solid === "cone" && index <= 1 && (r * r * h) % 3 !== 0)
      h = 3 * rng.int(1, Math.max(1, Math.floor((2 * high) / 3)));
    const byDiameter =
      index >= 1 && solid !== "silo" && solid !== "cylinder-height" && rng.int(0, 2) === 0;
    const answer = volumeOverPi(solid, r, h);
    const name = SOLID_NAME[solid];
    const radiusText = byDiameter ? `diámetro $${2 * r}$ ${unit}` : `radio $${r}$ ${unit}`;
    const dims = {
      radius: byDiameter ? 2 * r : r,
      unit,
      ...(byDiameter ? { diameter: true } : {}),
    };
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (solid === "cylinder-height") {
      const volume = volumeOverPi("cylinder", r, h);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Un cilindro de radio $${r}$ ${unit} tiene un volumen de ${piMath(volume)} ${unit}³. ¿Cuál es su altura?`,
          ),
          { figure: { kind: "cylinder", params: { radius: r, height: "h", unit } } },
        ],
        correct: numberChoice(h, "none"),
        distractors: [
          numberChoice(volume.div(Rational.of(r)), "divided-by-the-radius"),
          numberChoice(volume.div(Rational.of(2 * r)), "used-the-diameter"),
          numberChoice(volume, "forgot-to-divide"),
        ],
        pool: [
          "El volumen del cilindro es $V = \\pi r^2 h$.",
          `$\\pi \\cdot ${r}^2 \\cdot h = ${piMath(volume).slice(1, -1)}$`,
          `$${r * r} h = ${math(volume).slice(1, -1)}$`,
          `$h = ${math(volume).slice(1, -1)} \\div ${r * r}$`,
          `La altura es (en ${unit}):`,
          math(h),
        ],
        numericValues: [r],
        problem: { solid, r, h },
        fallback: "natural",
      });
    }

    const r2 = Rational.of(r * r);
    const r3 = Rational.of(r * r * r);
    const hr = Rational.of(h);
    const d = 2 * r;
    const distractors: OptionCandidate[] = [];
    let formula: string;
    let working: string;
    let figure: FigureSpec | undefined;
    switch (solid) {
      case "cylinder":
        formula = "$V = \\pi r^2 h$";
        working = `$V = \\pi \\cdot ${r}^2 \\cdot ${h}$`;
        distractors.push(
          piChoice(Rational.of(2 * r * h), "used-the-lateral-area"),
          piChoice(r2.mul(hr).div(Rational.of(3)), "used-the-cone-formula"),
          piChoice(
            byDiameter ? Rational.of(d * d * h) : Rational.of(r * h),
            byDiameter ? "used-the-diameter" : "forgot-to-square",
          ),
          piChoice(Rational.of(r * h), "forgot-to-square"),
          piChoice(r2.mul(hr).mul(Rational.of(2)), "doubled-the-volume"),
          piChoice(Rational.of(r * r + h), "added-instead-of-multiplying"),
        );
        figure = { kind: "cylinder", params: { ...dims, height: h } };
        break;
      case "cone":
        formula = "$V = \\dfrac{1}{3}\\pi r^2 h$";
        working = `$V = \\dfrac{1}{3} \\cdot \\pi \\cdot ${r}^2 \\cdot ${h}$`;
        distractors.push(
          piChoice(r2.mul(hr), "forgot-the-third"),
          piChoice(
            byDiameter ? Rational.of(d * d * h, 3) : Rational.of(r * h, 3),
            byDiameter ? "used-the-diameter" : "forgot-to-square",
          ),
          piChoice(r2.mul(hr).div(Rational.of(2)), "used-one-half"),
          piChoice(Rational.of(r * h, 3), "forgot-to-square"),
          piChoice(r2.mul(hr).mul(Rational.of(2, 3)), "used-two-thirds"),
          piChoice(Rational.of(r * r + h, 3), "added-instead-of-multiplying"),
        );
        figure = { kind: "cone", params: { ...dims, height: h } };
        break;
      case "sphere":
      case "hemisphere": {
        const half = solid === "hemisphere";
        formula = half ? "$V = \\dfrac{2}{3}\\pi r^3$" : "$V = \\dfrac{4}{3}\\pi r^3$";
        working = `$V = ${half ? "\\dfrac{2}{3}" : "\\dfrac{4}{3}"} \\cdot \\pi \\cdot ${r}^3$`;
        distractors.push(
          piChoice(r2.mul(Rational.of(4)), "used-the-surface-area"),
          piChoice(
            half ? r3.mul(Rational.of(4, 3)) : r3.mul(Rational.of(4)),
            half ? "forgot-to-halve" : "forgot-the-third",
          ),
          piChoice(r2.mul(Rational.of(half ? 2 : 4, 3)), "squared-instead-of-cubing"),
          piChoice(
            byDiameter ? Rational.of(d * d * d).mul(Rational.of(half ? 2 : 4, 3)) : r3,
            byDiameter ? "used-the-diameter" : "forgot-the-coefficient",
          ),
          piChoice(r3.mul(Rational.of(3, 4)), "inverted-the-coefficient"),
          piChoice(r3.mul(Rational.of(1, 3)), "dropped-the-four"),
        );
        figure = { kind: "sphere", params: { ...dims, ...(half ? { half: true } : {}) } };
        break;
      }
      default:
        formula = "$V = \\pi r^2 h + \\dfrac{2}{3}\\pi r^3$";
        working = `$V = \\pi \\cdot ${r}^2 \\cdot ${h} + \\dfrac{2}{3}\\pi \\cdot ${r}^3$`;
        distractors.push(
          piChoice(r2.mul(hr).add(r3.mul(Rational.of(4, 3))), "used-a-whole-sphere"),
          piChoice(r2.mul(hr), "forgot-the-dome"),
          piChoice(r2.mul(hr).add(r2.mul(Rational.of(2))), "used-the-dome-surface"),
          piChoice(r2.mul(hr).add(r3.mul(Rational.of(1, 3))), "used-a-cone-on-top"),
        );
        figure = undefined;
    }
    const stem =
      solid === "silo"
        ? `Un silo es un cilindro de radio $${r}$ ${unit} y altura $${h}$ ${unit} con una semiesfera del mismo radio encima. ¿Cuál es su volumen en términos de $\\pi$?`
        : solid === "sphere" || solid === "hemisphere"
          ? `¿Cuál es el volumen de una ${name} de ${radiusText}? Da la respuesta en términos de $\\pi$.`
          : `¿Cuál es el volumen de un ${name} de ${radiusText} y altura $${h}$ ${unit}? Da la respuesta en términos de $\\pi$.`;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(stem), ...(figure === undefined ? [] : [{ figure }])],
      correct: piChoice(answer, "none"),
      distractors,
      pool: [
        byDiameter ? `El radio es la mitad del diámetro: $r = ${r}$.` : `El radio es $r = ${r}$.`,
        formula,
        working,
        `$V = ${piMath(answer).slice(1, -1)}$`,
        `El volumen es (en ${unit}³):`,
        piMath(answer),
      ],
      numericValues:
        solid === "sphere" || solid === "hemisphere"
          ? [byDiameter ? d : r]
          : [byDiameter ? d : r, h],
      problem: { solid, r, h },
      fallback: "none",
    });
  },
};
