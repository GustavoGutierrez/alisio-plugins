import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "third-angle"
  | "isosceles-base"
  | "isosceles-vertex"
  | "exterior"
  | "polygon-sum"
  | "regular-interior"
  | "regular-exterior"
  | "sides-from-interior"
  | "sides-from-sum";

/** Regular polygons whose interior and exterior angles are whole degrees and differ. */
const REGULAR = [3, 5, 6, 8, 9, 10, 12] as const;
const NAMES: Record<number, string> = {
  3: "triángulo equilátero",
  4: "cuadrado",
  5: "pentágono",
  6: "hexágono",
  7: "heptágono",
  8: "octágono",
  9: "eneágono",
  10: "decágono",
  12: "dodecágono",
};

export const interiorSum = (sides: number): number => (sides - 2) * 180;

/** Angle sums in triangles and polygons, isosceles and exterior angles (EBC 6-8, geometry). */
export const triangleAngles: Family = {
  id: "triangle-angles",
  solve(problem: Record<string, unknown>): Rational {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const n = Number(problem.n);
    switch (problem.variant as Variant) {
      case "third-angle":
        return Rational.of(180 - a - b);
      case "isosceles-base":
        return Rational.of(180 - a, 2);
      case "isosceles-vertex":
        return Rational.of(180 - 2 * a);
      case "exterior":
        return Rational.of(a + b);
      case "polygon-sum":
        return Rational.of(interiorSum(n));
      case "regular-interior":
        return Rational.of(interiorSum(n), n);
      case "regular-exterior":
        return Rational.of(360, n);
      default:
        return Rational.of(n);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["third-angle", "isosceles-base", "isosceles-vertex"],
        ["third-angle", "isosceles-base", "exterior", "polygon-sum"],
        ["exterior", "polygon-sum", "regular-interior", "regular-exterior"],
        ["regular-interior", "sides-from-interior", "sides-from-sum", "exterior"],
      ]),
    );
    const family = "triangle-angles";
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (variant === "third-angle" || variant === "exterior") {
      // Whole multiples of 5° at basico, any whole degree later; every angle at least 15°.
      const unit = index === 0 ? 5 : 1;
      const a = rng.int(20 / unit, 100 / unit) * unit;
      const c = rng.int(15 / unit, (160 - a) / unit) * unit;
      const b = 180 - a - c;
      const exterior = variant === "exterior";
      const answer = exterior ? a + c : b;
      const figure: FigureSpec = exterior
        ? {
            kind: "triangle",
            params: {
              angles: [a, b, c],
              angleLabels: [`${a}°`, "", `${c}°`],
              exterior: true,
              exteriorLabel: "x",
            },
          }
        : { kind: "triangle", params: { angles: [a, b, c], angleLabels: [`${a}°`, "x", `${c}°`] } };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            exterior
              ? `En el triángulo ABC, $\\angle A = ${a}^{\\circ}$ y $\\angle C = ${c}^{\\circ}$. ¿Cuánto mide el ángulo exterior $x$ en B?`
              : `En el triángulo ABC, $\\angle A = ${a}^{\\circ}$ y $\\angle C = ${c}^{\\circ}$. ¿Cuánto mide $x = \\angle B$?`,
          ),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors: exterior
          ? [
              numberChoice(b, "gave-the-interior-angle"),
              numberChoice(360 - a - c, "used-360"),
              numberChoice(Math.abs(a - c) || a + c + 10, "subtracted-the-angles"),
            ]
          : [
              numberChoice(360 - a - c, "used-360"),
              numberChoice(a + c, "added-the-given-angles"),
              numberChoice(180 - a, "subtracted-one-angle"),
            ],
        pool: [
          "Los ángulos interiores de un triángulo suman $180^{\\circ}$.",
          exterior
            ? "Un ángulo exterior es igual a la suma de los dos interiores no adyacentes."
            : `$${a} + ${c} = ${a + c}$`,
          exterior ? `$x = ${a} + ${c}$` : `$x = 180 - ${a + c}$`,
          `$x = ${answer}^{\\circ}$`,
          "El ángulo mide (en grados):",
          math(answer),
        ],
        numericValues: [],
        problem: { variant, a, b: c, n: 3 },
      });
    }

    if (variant === "isosceles-base" || variant === "isosceles-vertex") {
      const base = variant === "isosceles-base";
      // The vertex angle is even so each base angle is a whole number of degrees.
      const vertexAngle = index === 0 ? rng.int(2, 16) * 10 : 2 * rng.int(10, 80);
      const baseAngle = (180 - vertexAngle) / 2;
      const given = base ? vertexAngle : baseAngle;
      const answer = base ? baseAngle : vertexAngle;
      const figure: FigureSpec = {
        kind: "triangle",
        params: {
          angles: [baseAngle, baseAngle, vertexAngle],
          angleLabels: base ? ["x", "", `${vertexAngle}°`] : [`${baseAngle}°`, "", "x"],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            base
              ? `El triángulo ABC es isósceles con $AC = BC$ y el ángulo desigual $\\angle C = ${vertexAngle}^{\\circ}$. ¿Cuánto mide $x = \\angle A$?`
              : `El triángulo ABC es isósceles con $AC = BC$ y $\\angle A = ${baseAngle}^{\\circ}$. ¿Cuánto mide $x = \\angle C$?`,
          ),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors: base
          ? [
              numberChoice(180 - vertexAngle, "forgot-to-halve"),
              numberChoice(vertexAngle, "copied-the-vertex-angle"),
              numberChoice((360 - vertexAngle) / 2, "used-360"),
            ]
          : [
              numberChoice(180 - baseAngle, "subtracted-one-base-angle"),
              numberChoice(baseAngle, "copied-the-base-angle"),
              numberChoice(2 * baseAngle, "doubled-the-base-angle"),
            ],
        pool: [
          "En un triángulo isósceles los ángulos de la base son iguales.",
          "Los tres ángulos suman $180^{\\circ}$.",
          base
            ? `$2x + ${vertexAngle} = 180$, así que $2x = ${180 - vertexAngle}$.`
            : `$x + 2 \\cdot ${baseAngle} = 180$, así que $x = 180 - ${2 * baseAngle}$.`,
          `$x = ${answer}^{\\circ}$`,
          "El ángulo mide (en grados):",
          math(answer),
        ],
        numericValues: [],
        problem: { variant, a: given, b: 0, n: 3 },
      });
    }

    if (variant === "polygon-sum" || variant === "sides-from-sum") {
      const n = rng.int(4, index >= 3 ? 20 : 12);
      const sum = interiorSum(n);
      const asksSides = variant === "sides-from-sum";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            asksSides
              ? `Los ángulos interiores de un polígono suman $${sum}^{\\circ}$. ¿Cuántos lados tiene?`
              : `¿Cuánto suman los ángulos interiores de un polígono de $${n}$ lados?`,
          ),
          ...(asksSides || n > 12
            ? []
            : [
                {
                  figure: {
                    kind: "polygon",
                    label: `Polígono de ${n} lados`,
                    params: { sides: n },
                  } as FigureSpec,
                },
              ]),
        ],
        correct: numberChoice(asksSides ? n : sum, "none"),
        distractors: asksSides
          ? [
              numberChoice(sum / 180, "forgot-to-add-two"),
              numberChoice(sum / 180 + 1, "added-one"),
              numberChoice(Math.round(sum / 360), "divided-by-360"),
            ]
          : [
              numberChoice(n * 180, "forgot-to-subtract-two"),
              numberChoice((n - 1) * 180, "subtracted-one"),
              numberChoice((n - 2) * 90, "used-90"),
            ],
        pool: [
          "Un polígono de $n$ lados se divide en $n - 2$ triángulos.",
          "La suma de sus ángulos interiores es $(n - 2) \\cdot 180^{\\circ}$.",
          asksSides
            ? `$(n - 2) \\cdot 180 = ${sum}$`
            : `$(${n} - 2) \\cdot 180 = ${n - 2} \\cdot 180$`,
          asksSides ? `$n - 2 = ${sum / 180}$` : `$= ${sum}$`,
          asksSides ? "El número de lados es:" : "La suma es (en grados):",
          math(asksSides ? n : sum),
        ],
        numericValues: [asksSides ? n - 2 : n],
        problem: { variant, a: 0, b: 0, n },
      });
    }

    const n = rng.pick(REGULAR);
    const interior = interiorSum(n) / n;
    const exteriorAngle = 360 / n;
    const name = NAMES[n] ?? `polígono de ${n} lados`;
    const figure: FigureSpec = {
      kind: "polygon",
      params:
        variant === "regular-exterior"
          ? { sides: n, markAngle: "x", exterior: true }
          : { sides: n, markAngle: "x" },
    };

    if (variant === "sides-from-interior") {
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Cada ángulo interior de un polígono regular mide $${interior}^{\\circ}$. ¿Cuántos lados tiene?`,
          ),
        ],
        correct: numberChoice(n, "none"),
        distractors: [
          numberChoice(n + 2, "added-two"),
          numberChoice(
            Math.round(360 / interior) === n ? n - 1 : Math.round(360 / interior),
            "divided-360-by-the-interior",
          ),
          numberChoice(Math.round(interior / 10), "read-the-tens"),
        ],
        pool: [
          "Interior y exterior de un mismo vértice suman $180^{\\circ}$.",
          `Ángulo exterior: $180 - ${interior} = ${exteriorAngle}^{\\circ}$`,
          "Los ángulos exteriores de un polígono regular suman $360^{\\circ}$.",
          `$n = 360 \\div ${exteriorAngle} = ${n}$`,
          "El número de lados es:",
          math(n),
        ],
        numericValues: [],
        problem: { variant, a: interior, b: 0, n },
      });
    }

    const asksExterior = variant === "regular-exterior";
    const answer = asksExterior ? exteriorAngle : interior;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          asksExterior
            ? `¿Cuánto mide cada ángulo exterior $x$ de un ${name} regular?`
            : `¿Cuánto mide cada ángulo interior $x$ de un ${name} regular?`,
        ),
        { figure },
      ],
      correct: numberChoice(answer, "none"),
      distractors: asksExterior
        ? [
            numberChoice(interior, "gave-the-interior-angle"),
            numberChoice(Rational.of(180, n), "divided-180"),
            numberChoice(interiorSum(n), "gave-the-sum"),
          ]
        : [
            numberChoice(exteriorAngle, "gave-the-exterior-angle"),
            numberChoice(interiorSum(n), "forgot-to-divide"),
            numberChoice(180, "used-180"),
          ],
      pool: [
        asksExterior
          ? "Los ángulos exteriores de cualquier polígono suman $360^{\\circ}$."
          : `Los ángulos interiores suman $(${n} - 2) \\cdot 180 = ${interiorSum(n)}^{\\circ}$.`,
        `El polígono es regular: sus $${n}$ ángulos son iguales.`,
        asksExterior ? `$x = 360 \\div ${n}$` : `$x = ${interiorSum(n)} \\div ${n}$`,
        `$x = ${answer}^{\\circ}$`,
        "Cada ángulo mide (en grados):",
        math(answer),
      ],
      numericValues: [n],
      problem: { variant, a: 0, b: 0, n },
      fallback: "natural",
    });
  },
};
