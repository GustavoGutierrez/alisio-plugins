import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "similar-side" | "scale-factor" | "thales" | "shadow" | "area-ratio";

/** Triangles with whole sides that look like triangles (no sliver shapes), smallest first. */
const SHAPES: ReadonlyArray<readonly [number, number, number]> = [
  [3, 4, 5],
  [4, 5, 6],
  [5, 6, 7],
  [4, 6, 7],
  [5, 7, 8],
  [6, 8, 9],
  [3, 5, 6],
  [6, 7, 9],
];

/** Scale factors by level: whole at basico, simple fractions later. */
const FACTORS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [2, 1],
    [3, 1],
  ],
  [
    [2, 1],
    [3, 1],
    [3, 2],
    [4, 1],
  ],
  [
    [3, 2],
    [5, 2],
    [4, 3],
    [2, 1],
  ],
  [
    [3, 2],
    [5, 2],
    [4, 3],
    [5, 3],
  ],
];

const SIDE_NAMES = ["AB", "BC", "CA"] as const;
const IMAGE_NAMES = ["DE", "EF", "FD"] as const;

/** Similar triangles, scale factors, Thales' parallel lines, shadows and area ratios (DBA 8 #6). */
export const similarityThales: Family = {
  id: "similarity-thales",
  solve(problem: Record<string, unknown>): Rational {
    const k = Rational.parse(String(problem.k));
    switch (problem.variant as Variant) {
      case "similar-side":
        return Rational.of(Number(problem.side)).mul(k);
      case "scale-factor":
        return k;
      case "thales":
      case "shadow":
        return Rational.of(Number(problem.b) * Number(problem.c), Number(problem.a));
      default:
        return Rational.of(Number(problem.area)).mul(k).mul(k);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["similar-side", "scale-factor"],
        ["similar-side", "scale-factor", "thales"],
        ["similar-side", "thales", "shadow"],
        ["thales", "shadow", "area-ratio", "similar-side"],
      ]),
    );
    const family = "similarity-thales";
    const unit = rng.pick(["cm", "m"]);
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (variant === "similar-side" || variant === "scale-factor" || variant === "area-ratio") {
      const [num, den] = rng.pick(tier(index, FACTORS)) ?? [2, 1];
      const k = Rational.of(num, den);
      // Sides that are multiples of the denominator keep every image side a whole number.
      const base = rng
        .pick(SHAPES)
        .map((side) => side * den * rng.pick([1, 1, 2].slice(0, index + 1)));
      const sides = [base[0] ?? 3, base[1] ?? 4, base[2] ?? 5];
      const images = sides.map((side) => (side * num) / den);
      const hidden = rng.int(0, 2);
      const figure: FigureSpec = {
        kind: "similar-triangles",
        params: {
          ratio: num / den,
          sides,
          labels: sides.map(String),
          imageLabels: images.map((side, position) =>
            variant === "similar-side" && position === hidden ? "x" : String(side),
          ),
        },
      };
      if (variant === "area-ratio") {
        const area = rng.int(2, 12) * den * den;
        const answer = k.mul(k).mul(Rational.of(area));
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              `Dos triángulos son semejantes con razón de semejanza $${math(k).slice(1, -1)}$ (del pequeño al grande). Si el pequeño tiene área $${area}$ ${unit}², ¿cuál es el área del grande?`,
            ),
          ],
          correct: numberChoice(answer, "none"),
          distractors: [
            numberChoice(k.mul(Rational.of(area)), "used-the-linear-ratio"),
            numberChoice(Rational.of(area).div(k.mul(k)), "divided-by-the-ratio"),
            numberChoice(Rational.of(area).add(k.mul(k)), "added-the-ratio"),
            numberChoice(k.mul(Rational.of(2 * area)), "doubled-the-ratio"),
          ],
          pool: [
            "Si los lados están en razón $k$, las áreas están en razón $k^2$.",
            `$k = ${math(k).slice(1, -1)}$, así que $k^2 = ${math(k.mul(k)).slice(1, -1)}$.`,
            `$A = ${area} \\cdot ${math(k.mul(k)).slice(1, -1)}$`,
            `$A = ${math(answer).slice(1, -1)}$`,
            `El área del grande es (en ${unit}²):`,
            math(answer),
          ],
          numericValues: [area],
          problem: { variant, k: k.toString(), area },
          fallback: "none",
        });
      }
      if (variant === "scale-factor") {
        const position = rng.int(0, 2);
        const small = sides[position] ?? 1;
        const large = images[position] ?? 1;
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            ask(
              `Los triángulos ABC y DEF son semejantes. ¿Cuál es la razón de semejanza $\\dfrac{${IMAGE_NAMES[position]}}{${SIDE_NAMES[position]}}$?`,
            ),
            { figure },
          ],
          correct: numberChoice(k, "none"),
          distractors: [
            numberChoice(k.inv(), "inverted-the-ratio"),
            numberChoice(Rational.of(large - small), "subtracted-the-sides"),
            numberChoice(Rational.of(large + small, small), "added-the-sides"),
          ],
          pool: [
            "En triángulos semejantes, los lados correspondientes son proporcionales.",
            `$${IMAGE_NAMES[position]} = ${large}$ y $${SIDE_NAMES[position]} = ${small}$.`,
            `$\\dfrac{${large}}{${small}}$`,
            "Simplifica la fracción.",
            "La razón de semejanza es:",
            math(k),
          ],
          numericValues: [small],
          problem: { variant, k: k.toString() },
          fallback: "any",
        });
      }
      const side = sides[hidden] ?? 1;
      const answer = images[hidden] ?? 1;
      const known = (hidden + 1) % 3;
      const knownSmall = sides[known] ?? 1;
      const knownLarge = images[known] ?? 1;
      const other = sides[(hidden + 2) % 3] ?? 1;
      const distractors: OptionCandidate[] = [
        numberChoice(side + (knownLarge - knownSmall), "added-the-difference"),
        numberChoice(Rational.of(side * den, num), "divided-by-the-ratio"),
        numberChoice(Rational.of(other * num, den), "matched-the-wrong-side"),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Los triángulos ABC y DEF son semejantes ($A \\to D$, $B \\to E$, $C \\to F$). ¿Cuánto mide $x = ${IMAGE_NAMES[hidden]}$?`,
          ),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors,
        pool: [
          "Los lados correspondientes de triángulos semejantes son proporcionales.",
          `Razón: $\\dfrac{${IMAGE_NAMES[known]}}{${SIDE_NAMES[known]}} = \\dfrac{${knownLarge}}{${knownSmall}} = ${math(k).slice(1, -1)}$`,
          `$x = ${side} \\cdot ${math(k).slice(1, -1)}$`,
          `$x = ${answer}$`,
          `La medida es (en ${unit}):`,
          math(answer),
        ],
        numericValues: sides,
        problem: { variant, k: k.toString(), side },
        fallback: "natural",
      });
    }

    // Thales and shadows: a/b = c/x with x = b·c/a a whole number.
    const a = rng.int(2, index >= 2 ? 9 : 6);
    const factor = rng.int(1, index >= 2 ? 4 : 3);
    const b = a * factor + (index >= 2 && rng.int(0, 1) === 0 ? a : 0);
    const c = rng.int(2, 9);
    const answer = Rational.of(b * c, a);
    if (variant === "shadow") {
      const stick = c;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `A la misma hora, un poste de $${stick}$ m proyecta una sombra de $${a}$ m y un edificio proyecta una sombra de $${b}$ m. ¿Cuánto mide el edificio?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(a * b, stick), "inverted-the-ratio"),
          numberChoice(stick + (b - a), "added-the-difference"),
          numberChoice(Rational.of(a * stick, b), "crossed-the-wrong-terms"),
        ],
        pool: [
          "Los rayos del sol forman triángulos semejantes: altura y sombra son proporcionales.",
          `$\\dfrac{h}{${b}} = \\dfrac{${stick}}{${a}}$`,
          `$h = \\dfrac{${b} \\cdot ${stick}}{${a}}$`,
          `$h = ${math(answer).slice(1, -1)}$`,
          "El edificio mide (en metros):",
          math(answer),
        ],
        numericValues: [stick, a, b],
        problem: { variant, a, b, c: stick, k: "1" },
        fallback: "natural",
      });
    }
    const figure: FigureSpec = {
      kind: "similar-triangles",
      params: { mode: "nested", cut: a / (a + b), labels: [String(a), String(b), String(c), "x"] },
    };
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `En el triángulo ABC, el segmento DE es paralelo a BC. Si $AD = ${a}$, $DB = ${b}$ y $AE = ${c}$ (en ${unit}), ¿cuánto mide $x = EC$?`,
        ),
        { figure },
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(Rational.of(a * c, b), "crossed-the-wrong-segments"),
        numberChoice(c + (b - a), "added-the-difference"),
        numberChoice(Rational.of(a * b, c), "inverted-the-proportion"),
      ],
      pool: [
        "Teorema de Tales: las paralelas cortan segmentos proporcionales.",
        `$\\dfrac{AD}{DB} = \\dfrac{AE}{EC}$`,
        `$\\dfrac{${a}}{${b}} = \\dfrac{${c}}{x}$`,
        `$x = \\dfrac{${b} \\cdot ${c}}{${a}}$`,
        `EC mide (en ${unit}):`,
        math(answer),
      ],
      numericValues: [a, b, c],
      problem: { variant, a, b, c, k: "1" },
      fallback: "natural",
    });
  },
};
