import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, positiveValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Variant =
  | "area-rectangle"
  | "perimeter-rectangle"
  | "area-square"
  | "perimeter-triangle"
  | "polygon-sides";

interface Problem {
  variant: Variant;
  a: number;
  b?: number;
  sides?: number;
}

/** Figure-based geometry: area and perimeter of simple shapes, and counting polygon sides. */
export const geometry: Family = {
  id: "geometry",
  solve(problem: Record<string, unknown>): Rational {
    const value = problem as unknown as Problem;
    switch (value.variant) {
      case "perimeter-rectangle":
        return Rational.of(2 * (value.a + (value.b ?? value.a)));
      case "area-square":
        return Rational.of(value.a * value.a);
      case "perimeter-triangle":
        return Rational.of(3 * value.a);
      case "polygon-sides":
        return Rational.of(value.sides ?? value.a);
      default:
        return Rational.of(value.a * (value.b ?? value.a));
    }
  },
  generate({ rng, level, calibration }): ItemDraft {
    const variant = rng.pick([
      "area-rectangle",
      "perimeter-rectangle",
      "area-square",
      "perimeter-triangle",
      "polygon-sides",
    ] as const);
    const w = positiveValue(rng, calibration.coefficientRange);
    let h = positiveValue(rng, calibration.coefficientRange);
    if (h === w) h = w === 1 ? 2 : w + 1;

    let problem: Problem;
    let figure: FigureSpec;
    let instruction: string;
    let answer: Rational;
    let numericValues: number[];
    let distractors: { value: Rational; error: string }[];

    if (variant === "polygon-sides") {
      const sides = rng.int(3, Math.max(3, Math.min(10, calibration.coefficientRange[1])));
      problem = { variant, a: sides, sides };
      figure = { kind: "polygon", params: { sides }, label: `Polígono de ${sides} lados` };
      instruction = "¿Cuántos lados tiene la figura?";
      answer = Rational.of(sides);
      numericValues = [sides];
      distractors = [
        { value: Rational.of(sides + 1), error: "off-by-one" },
        { value: Rational.of(Math.max(3, sides - 1)), error: "off-by-one" },
        { value: Rational.of(sides + 2), error: "off-by-two" },
      ];
    } else if (variant === "area-square") {
      problem = { variant, a: w };
      figure = { kind: "square", label: "Cuadrado" };
      instruction = `Observa el cuadrado. Si su lado mide $${w}$, ¿cuál es su área?`;
      answer = Rational.of(w * w);
      numericValues = [w];
      distractors = [
        { value: Rational.of(4 * w), error: "used-perimeter" },
        { value: Rational.of(2 * w), error: "added-two-sides" },
        { value: Rational.of(w * w + w), error: "extra-side" },
      ];
    } else if (variant === "perimeter-triangle") {
      problem = { variant, a: w };
      figure = {
        kind: "triangle",
        params: { variant: "equilateral" },
        label: "Triángulo equilátero",
      };
      instruction = `El triángulo es equilátero y su lado mide $${w}$. ¿Cuál es su perímetro?`;
      answer = Rational.of(3 * w);
      numericValues = [w];
      distractors = [
        { value: Rational.of(w * w), error: "used-area" },
        { value: Rational.of(2 * w), error: "used-two-sides" },
        { value: Rational.of(w + 3), error: "added-the-number-of-sides" },
      ];
    } else if (variant === "perimeter-rectangle") {
      problem = { variant, a: w, b: h };
      figure = { kind: "rectangle", label: "Rectángulo" };
      instruction = `El rectángulo mide $${w}$ de ancho y $${h}$ de alto. ¿Cuál es su perímetro?`;
      answer = Rational.of(2 * (w + h));
      numericValues = [w, h];
      distractors = [
        { value: Rational.of(w * h), error: "used-area" },
        { value: Rational.of(w + h), error: "added-two-sides" },
        { value: Rational.of(2 * w + h), error: "forgot-a-pair" },
      ];
    } else {
      problem = { variant, a: w, b: h };
      figure = { kind: "rectangle", label: "Rectángulo" };
      instruction = `El rectángulo mide $${w}$ de ancho y $${h}$ de alto. ¿Cuál es su área?`;
      answer = Rational.of(w * h);
      numericValues = [w, h];
      distractors = [
        { value: Rational.of(2 * (w + h)), error: "used-perimeter" },
        { value: Rational.of(w + h), error: "added-sides" },
        { value: Rational.of(w * h + h), error: "extra-column" },
      ];
    }

    const pool = [
      "Identifica la figura y sus medidas.",
      instruction,
      "Aplica la fórmula de área o de perímetro según corresponda.",
      "Multiplica o suma las medidas.",
      "Comprueba si el resultado es lineal o cuadrado.",
      "Revisa el cálculo.",
      "El resultado es:",
      money(answer),
    ];
    const solution = pooled(pool, rng, calibration);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        ...distractors.map((entry) => ({
          value: entry.value.toString(),
          display: money(entry.value),
          error: entry.error,
        })),
        ...perturb(answer),
      ],
    );

    return {
      family: "geometry",
      level,
      type: "single_choice",
      stem: [instruction, { figure }],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues,
      stepCount: solution.length,
      problem: { ...problem },
    };
  },
};
