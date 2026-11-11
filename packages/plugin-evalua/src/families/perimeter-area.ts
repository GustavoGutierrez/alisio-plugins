import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "rect-perimeter"
  | "rect-area"
  | "l-perimeter"
  | "l-area"
  | "side-from-perimeter"
  | "side-from-area";

interface Shape {
  width: number;
  height: number;
  cutWidth: number;
  cutHeight: number;
}

const area = (shape: Shape): number =>
  shape.width * shape.height - shape.cutWidth * shape.cutHeight;
/** Cutting a corner never changes the perimeter of the bounding rectangle. */
const perimeter = (shape: Shape): number => 2 * (shape.width + shape.height);

/** Perimeter and area of rectangles and L-shaped figures, and a missing side (DBA 3 #4, 5 #5). */
export const perimeterArea: Family = {
  id: "perimeter-area",
  solve(problem: Record<string, unknown>): Rational {
    const shape = problem as unknown as Shape & { variant: Variant; given: number };
    switch (shape.variant) {
      case "rect-perimeter":
      case "l-perimeter":
        return Rational.of(perimeter(shape));
      case "side-from-perimeter":
        return Rational.of(shape.given / 2 - shape.width);
      case "side-from-area":
        return Rational.of(shape.given / shape.width);
      default:
        return Rational.of(area(shape));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variants = tier<Variant>(index, [
      ["rect-perimeter", "rect-area"],
      ["rect-perimeter", "rect-area", "l-perimeter", "l-area"],
      ["l-perimeter", "l-area", "side-from-perimeter", "rect-area"],
      ["l-perimeter", "l-area", "side-from-perimeter", "side-from-area"],
    ]);
    const variant = rng.pick(variants);
    const high = levelHigh(calibration, [10, 20, 40, 60][index] ?? 20, 4);
    const unit = rng.pick(["cm", "m"]);
    const isL = variant.startsWith("l-");
    const width = rng.int(isL ? 3 : 2, high);
    let height = rng.int(isL ? 3 : 1, high);
    if (height === width && !isL) height = width === high ? width - 1 : width + 1;
    const cutWidth = isL ? rng.int(1, width - 1) : 0;
    const cutHeight = isL ? rng.int(1, height - 1) : 0;
    const shape: Shape = { width, height, cutWidth, cutHeight };
    const squared = `${unit === "cm" ? "centímetros" : "metros"} cuadrados`;
    const linear = unit === "cm" ? "centímetros" : "metros";

    if (variant === "side-from-perimeter" || variant === "side-from-area") {
      const given = variant === "side-from-perimeter" ? perimeter(shape) : area(shape);
      const figure: FigureSpec = {
        kind: "composite-rect",
        params: { width, height, unit, hidden: [1, 3] },
      };
      const ask =
        variant === "side-from-perimeter"
          ? `El perímetro del rectángulo es $${given}$ ${linear} y su base mide $${width}$ ${linear}. ¿Cuánto mide su altura?`
          : `El área del rectángulo es $${given}$ ${squared} y su base mide $${width}$ ${linear}. ¿Cuánto mide su altura?`;
      const distractors: OptionCandidate[] =
        variant === "side-from-perimeter"
          ? [
              numberChoice(given - width, "forgot-to-halve"),
              numberChoice(given / 2, "forgot-to-subtract-the-base"),
              numberChoice(Math.abs(given - 2 * width) || height + 2, "forgot-to-halve"),
            ]
          : [
              numberChoice(given - width, "subtracted-instead"),
              numberChoice(
                Math.abs(Math.floor(given / 2) - width) || height + 2,
                "used-perimeter-rule",
              ),
              numberChoice(given * width, "multiplied-instead"),
            ];
      return finishDraft({
        family: "perimeter-area",
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, ask, ""), { figure }],
        correct: numberChoice(height, "none"),
        distractors,
        pool: [
          "Escribe la fórmula y reemplaza lo que conoces.",
          variant === "side-from-perimeter"
            ? `$2 \\times (${width} + h) = ${given}$`
            : `$${width} \\times h = ${given}$`,
          variant === "side-from-perimeter"
            ? `$${width} + h = ${given / 2}$`
            : `$h = ${given} \\div ${width}$`,
          `$h = ${height}$`,
          "La altura mide:",
          `${math(height)} ${linear}`,
        ],
        numericValues: [given, width],
        problem: { variant, width, given, height, cutWidth: 0, cutHeight: 0 },
      });
    }

    const wantsArea = variant.endsWith("area");
    const answer = wantsArea ? area(shape) : perimeter(shape);
    const figure: FigureSpec = {
      kind: "composite-rect",
      params: {
        width,
        height,
        cutWidth,
        cutHeight,
        unit,
        ...(index === 0 && wantsArea ? { grid: true } : {}),
      },
    };
    const sides = isL
      ? [width, height - cutHeight, cutWidth, cutHeight, width - cutWidth, height]
      : [width, height];
    const distractors: OptionCandidate[] = wantsArea
      ? [
          numberChoice(perimeter(shape), "used-perimeter"),
          numberChoice(
            isL ? width * height : width + height,
            isL ? "forgot-the-cut" : "added-the-sides",
          ),
          numberChoice(
            isL ? width * height + cutWidth * cutHeight : width * height + height,
            isL ? "added-the-cut" : "extra-column",
          ),
        ]
      : [
          numberChoice(area(shape), "used-area"),
          numberChoice(
            isL ? perimeter(shape) - cutWidth - cutHeight : width + height,
            isL ? "skipped-the-inner-sides" : "added-two-sides",
          ),
          numberChoice(
            isL ? sides.reduce((sum, side) => sum + side, 0) - cutWidth : 2 * width + height,
            "forgot-a-side",
          ),
        ];
    const ask = wantsArea
      ? `¿Cuál es el área de la figura en ${squared}?`
      : `¿Cuál es el perímetro de la figura en ${linear}?`;
    const working = wantsArea
      ? isL
        ? [
            `Área del rectángulo completo: $${width} \\times ${height} = ${width * height}$`,
            `Área del recorte: $${cutWidth} \\times ${cutHeight} = ${cutWidth * cutHeight}$`,
            `$${width * height} - ${cutWidth * cutHeight} = ${answer}$`,
          ]
        : [
            "El área de un rectángulo es base por altura.",
            `$${width} \\times ${height} = ${answer}$`,
          ]
      : [
          `El perímetro es la suma de todos los lados.`,
          `$${(isL ? sides : [width, height, width, height]).join(" + ")} = ${answer}$`,
        ];
    return finishDraft({
      family: "perimeter-area",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, ask, ""), { figure }],
      correct: numberChoice(answer, "none"),
      distractors,
      pool: [
        "Identifica la figura y la medida de cada lado.",
        wantsArea
          ? "El área cuenta los cuadrados que cubren la figura."
          : "El perímetro mide el borde de la figura.",
        ...working,
        wantsArea ? `El área es (en ${squared}):` : `El perímetro es (en ${linear}):`,
        math(answer),
      ],
      numericValues: sides,
      problem: { variant, width, height, cutWidth, cutHeight },
    });
  },
};
