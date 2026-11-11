import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { decimalChoice, decimalMath } from "./exact.js";
import { finishDraft, levelIndex, textChoice, thousands, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "real-distance" | "drawing-distance" | "find-scale" | "real-area";
type Unit = "m" | "km";

/** Centimetres in one unit of the real-world answer. */
const CM_PER: Record<Unit, number> = { m: 100, km: 100_000 };
const UNIT_NAME: Record<Unit, string> = { m: "metros", km: "kilómetros" };

const SCALES = [
  [100, 200, 500],
  [200, 500, 1000, 2000],
  [1000, 2000, 5000, 25_000, 50_000],
  [5000, 25_000, 50_000, 100_000, 250_000],
] as const;

/** A map scale `1:n` as canonical text and inline math. */
export const scaleText = (n: number): string => `1:${n}`;
const scaleMath = (n: number): string => `$1:${thousands(n)}$`;
const scaleChoice = (n: number, error: string): OptionCandidate =>
  textChoice(scaleText(n), error, scaleMath(n));

/** The unit a real distance is asked in: kilometres for road maps, metres for plans. */
const unitFor = (scale: number): Unit => (scale >= 25_000 ? "km" : "m");

/** Real lengths from a scale drawing and back, the scale itself and real areas (DBA 7 #4). */
export const mapScale: Family = {
  id: "map-scale",
  solve(problem: Record<string, unknown>): Rational | string {
    const scale = Number(problem.scale);
    const drawing = Rational.parse(String(problem.drawing));
    const perUnit = Rational.of(CM_PER[(problem.unit as Unit) ?? "m"] ?? 100);
    switch (problem.variant as Variant) {
      case "real-distance":
        return drawing.mul(Rational.of(scale)).div(perUnit);
      case "drawing-distance":
        return drawing;
      case "find-scale":
        return scaleText(scale);
      default: {
        const width = Number(problem.width);
        const height = Number(problem.height);
        return Rational.of(width * height * scale * scale, 10_000);
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["real-distance", "drawing-distance"],
        ["real-distance", "drawing-distance", "find-scale"],
        ["real-distance", "drawing-distance", "find-scale"],
        ["real-distance", "find-scale", "real-area"],
      ]),
    );
    const family = "map-scale";
    const scale = rng.pick(tier<number>(index, SCALES));
    const unit = unitFor(scale);
    // Whole centimetres at basico, halves from intermedio: every real length stays exact.
    const halves = index > 0 && rng.int(0, 2) === 0;
    const drawing = halves ? Rational.of(rng.int(3, 19), 2) : Rational.of(rng.int(2, 11));
    const real = drawing.mul(Rational.of(scale)).div(Rational.of(CM_PER[unit]));
    const drawingCm = Number(drawing.n) / Number(drawing.d);
    const places = rng.pick([
      ["A", "B"],
      ["la casa", "el colegio"],
      ["el pueblo", "el río"],
      ["la plaza", "el parque"],
    ]);
    const mapFigure = (shown?: string): FigureSpec => ({
      kind: "scale-drawing",
      params: {
        length: drawingCm,
        scale: `1:${thousands(scale).replace(/\{\.\}/g, ".")}`,
        from: places[0],
        to: places[1],
        ...(shown === undefined ? {} : { shown }),
      },
    });
    const scaleLabel = `$1:${thousands(scale)}$`;

    if (variant === "real-distance" || variant === "drawing-distance") {
      const toReal = variant === "real-distance";
      const answer = toReal ? real : drawing;
      const asked = toReal ? UNIT_NAME[unit] : "centímetros";
      const ten = Rational.of(10);
      const realCm = drawing.mul(Rational.of(scale));
      const distractors = [
        decimalChoice(answer.mul(ten), "wrong-unit-conversion"),
        decimalChoice(answer.div(ten), "wrong-unit-conversion"),
        toReal
          ? decimalChoice(drawing.mul(Rational.of(scale)), "did-not-convert-from-cm")
          : decimalChoice(real.mul(Rational.of(CM_PER[unit])), "multiplied-by-the-scale"),
        decimalChoice(answer.mul(Rational.of(100)), "wrong-unit-conversion"),
      ];
      const stem = toReal
        ? `En un mapa a escala ${scaleLabel}, la distancia entre ${places[0]} y ${places[1]} mide ${decimalMath(drawing)} cm. ¿Cuál es la distancia real en ${asked}?`
        : `La distancia real entre ${places[0]} y ${places[1]} es ${decimalMath(real)} ${UNIT_NAME[unit]}. En un mapa a escala ${scaleLabel}, ¿cuántos centímetros las separan?`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, stem, ""), { figure: mapFigure(toReal ? undefined : "?") }],
        correct: decimalChoice(answer, "none"),
        distractors,
        pool: [
          `La escala ${scaleLabel} significa que $1$ cm del mapa son $${thousands(scale)}$ cm reales.`,
          toReal
            ? `$${decimalMath(drawing).slice(1, -1)} \\times ${thousands(scale)} = ${thousands(Number(realCm.n))}$ cm`
            : `Pasa a centímetros: ${decimalMath(real)} ${unit} $= ${thousands(Number(realCm.n))}$ cm`,
          toReal
            ? `$1$ ${unit === "m" ? "m" : "km"} $= ${thousands(CM_PER[unit])}$ cm, así que divide entre $${thousands(CM_PER[unit])}$.`
            : `Divide entre $${thousands(scale)}$.`,
          `El resultado es (en ${asked}):`,
          decimalMath(answer),
        ],
        numericValues: [Math.ceil(drawingCm)],
        problem: { variant, scale, unit, drawing: drawing.toString() },
        fallback: "none",
      });
    }

    if (variant === "find-scale") {
      const cm = Rational.of(rng.int(2, 9));
      const realCm = cm.mul(Rational.of(scale));
      const realShown = realCm.div(Rational.of(CM_PER[unit]));
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `En un plano, ${decimalMath(cm)} cm representan ${decimalMath(realShown)} ${UNIT_NAME[unit]} reales. ¿Cuál es la escala del plano?`,
            "",
          ),
        ],
        correct: scaleChoice(scale, "none"),
        distractors: [
          scaleChoice(scale / 100, "forgot-to-convert-to-cm"),
          scaleChoice(scale * 10, "wrong-unit-conversion"),
          scaleChoice(scale / 10, "wrong-unit-conversion"),
          textChoice(`${scale}:1`, "inverted-the-scale", `$${thousands(scale)}:1$`),
        ],
        pool: [
          "La escala compara la medida del plano con la real, en la misma unidad.",
          `${decimalMath(realShown)} ${unit} $= ${thousands(Number(realCm.n))}$ cm`,
          `$${thousands(Number(realCm.n))} \\div ${Number(cm.n)} = ${thousands(scale)}$`,
          "La escala es:",
          scaleMath(scale),
        ],
        numericValues: [Number(cm.n)],
        problem: { variant, scale, unit, drawing: cm.toString() },
        fallback: "none",
      });
    }

    // A rectangular floor plan: the real area grows with the square of the scale.
    const planScale = rng.pick([100, 200, 500]);
    const width = rng.int(3, 9);
    const height = rng.int(2, 6);
    const area = Rational.of(width * height * planScale * planScale, 10_000);
    const linear = Rational.of(width * height * planScale, 10_000);
    const figure: FigureSpec = {
      kind: "scale-drawing",
      params: { shape: "plan", width, height, scale: `1:${planScale}` },
    };
    const side = (cm: number) => Rational.of(cm * planScale, 100);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        prompt(
          rng,
          prompts,
          `Un salón mide $${width}$ cm por $${height}$ cm en un plano a escala $1:${planScale}$. ¿Cuál es su área real en metros cuadrados?`,
          "",
        ),
        { figure },
      ],
      correct: decimalChoice(area, "none"),
      distractors: [
        decimalChoice(linear, "did-not-square-the-scale"),
        decimalChoice(Rational.of(width * height), "used-the-plan-area"),
        decimalChoice(side(width).add(side(height)).mul(Rational.of(2)), "found-the-perimeter"),
        decimalChoice(area.mul(Rational.of(100)), "wrong-unit-conversion"),
        decimalChoice(area.div(Rational.of(100)), "wrong-unit-conversion"),
        decimalChoice(area.mul(Rational.of(10)), "wrong-unit-conversion"),
      ],
      pool: [
        "Pasa cada lado a su medida real.",
        `Largo real: $${width} \\times ${planScale} = ${width * planScale}$ cm $=$ ${decimalMath(side(width))} m`,
        `Ancho real: $${height} \\times ${planScale} = ${height * planScale}$ cm $=$ ${decimalMath(side(height))} m`,
        `Área: ${decimalMath(side(width))} $\\times$ ${decimalMath(side(height))}`,
        "El área real es (en metros cuadrados):",
        decimalMath(area),
      ],
      numericValues: [width, height],
      problem: { variant, scale: planScale, unit: "m", drawing: "0", width, height },
      fallback: "none",
    });
  },
};
