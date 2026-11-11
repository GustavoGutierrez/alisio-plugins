import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { surdChoice, surdMath, surdText } from "./exact.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "hypotenuse" | "leg" | "is-right" | "ladder" | "diagonal" | "radical";

/** Primitive Pythagorean triples (leg, leg, hypotenuse), scaled by the level. */
const TRIPLES: ReadonlyArray<readonly [number, number, number]> = [
  [3, 4, 5],
  [5, 12, 13],
  [8, 15, 17],
  [7, 24, 25],
  [20, 21, 29],
  [12, 35, 37],
  [9, 40, 41],
];

/** The scaled triples whose hypotenuse fits under `limit`. */
export function triplesUpTo(limit: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const [a, b, c] of TRIPLES) {
    for (let k = 1; k * c <= limit; k += 1) out.push([a * k, b * k, c * k]);
  }
  return out;
}

/**
 * The four statements of a converse question: exactly one pairs a true equation with the right
 * verdict; every distractor states an equation that is false for these sides.
 */
function verdicts(a: number, b: number, longest: number) {
  const holds = a * a + b * b === longest * longest;
  return {
    yes: `Sí, porque $${a}^2 + ${b}^2 = ${longest}^2$.`,
    no: `No, porque $${a}^2 + ${b}^2 \\neq ${longest}^2$.`,
    sum: `Sí, porque $${a} + ${b} = ${longest}$.`,
    swapped: `No, porque $${a}^2 + ${longest}^2 = ${b}^2$.`,
    holds,
  };
}

/** The Pythagorean theorem: hypotenuse, a leg, the converse and exact radicals (DBA 8 #7, 9 #5). */
export const pythagorean: Family = {
  id: "pythagorean",
  solve(problem: Record<string, unknown>): Rational | string {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    switch (problem.variant as Variant) {
      case "hypotenuse":
      case "diagonal":
        return surdText(Rational.one, a * a + b * b);
      case "leg":
      case "ladder":
        return surdText(Rational.one, c * c - a * a);
      case "is-right":
        return verdicts(a, b, c).holds ? "yes" : "no";
      default:
        return problem.ask === "leg"
          ? surdText(Rational.one, c * c - a * a)
          : surdText(Rational.one, a * a + b * b);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["hypotenuse", "leg"],
        ["hypotenuse", "leg", "is-right", "diagonal"],
        ["leg", "ladder", "diagonal", "is-right"],
        ["radical", "ladder", "radical", "is-right"],
      ]),
    );
    const family = "pythagorean";
    const limit = levelHigh(calibration, [20, 45, 90, 120][index] ?? 20, 5);
    const unit = rng.pick(["cm", "m"]);
    const options = triplesUpTo(limit);
    const [p, q, r] = rng.pick(
      options.length > 0 ? options : [[3, 4, 5] as [number, number, number]],
    );
    // Either leg may be the horizontal one, so (3, 4) and (4, 3) are both drawn.
    const [a, b] = rng.int(0, 1) === 0 ? [p, q] : [q, p];
    const c = r;
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const rightTriangle = (labels: [string, string, string], title?: string): FigureSpec => ({
      kind: "triangle",
      ...(title === undefined ? {} : { label: title }),
      params: { legs: [a, b], sideLabels: labels },
    });
    const withUnit = (value: number) => `${value} ${unit}`;

    if (variant === "is-right") {
      const right = rng.int(0, 1) === 0;
      // c + 1 keeps a valid triangle: a + b > c + 1 for every triple.
      const longest = right ? c : c + 1;
      const text = verdicts(a, b, longest);
      const verdict = right ? "yes" : "no";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Un triángulo tiene lados de $${a}$, $${b}$ y $${longest}$ ${unit}. ¿Es un triángulo rectángulo?`,
          ),
        ],
        correct: textChoice(verdict, "none", right ? text.yes : text.no),
        distractors: [
          textChoice(right ? "no" : "yes", "wrong-verdict", right ? text.no : text.yes),
          textChoice("sum", "added-the-sides", text.sum),
          textChoice("swapped", "misplaced-the-longest-side", text.swapped),
        ],
        pool: [
          "Un triángulo es rectángulo si $a^2 + b^2 = c^2$, con $c$ el lado mayor.",
          `$${a}^2 + ${b}^2 = ${a * a} + ${b * b} = ${a * a + b * b}$`,
          `$${longest}^2 = ${longest * longest}$`,
          right ? "Los dos valores son iguales." : "Los dos valores son distintos.",
          "La respuesta es:",
          right ? "Sí, es rectángulo." : "No es rectángulo.",
        ],
        numericValues: [a, b, longest],
        problem: { variant, a, b, c: longest },
        fallback: "none",
      });
    }

    if (variant === "radical") {
      // Legs that are not part of a triple, so the hypotenuse is a simplified square root.
      const small = Math.min(12, Math.max(4, Math.floor(limit / 4)));
      const x = rng.int(1, small);
      let y = rng.int(x + 1, small + 1);
      while (Number.isInteger(Math.sqrt(x * x + y * y))) y += 1;
      const asksLeg = rng.int(0, 2) === 0;
      let hyp = x + rng.int(1, small);
      while (Number.isInteger(Math.sqrt(hyp * hyp - x * x))) hyp += 1;
      const radicand = asksLeg ? hyp * hyp - x * x : x * x + y * y;
      const choices: OptionCandidate[] = asksLeg
        ? [
            surdChoice(hyp * hyp + x * x, "added-instead-of-subtracting"),
            numberChoice(hyp - x, "subtracted-the-sides"),
            numberChoice(radicand, "forgot-the-square-root"),
          ]
        : [
            numberChoice(x + y, "added-the-legs"),
            numberChoice(radicand, "forgot-the-square-root"),
            surdChoice(y * y - x * x, "subtracted-the-squares"),
            surdChoice(x * x + y, "forgot-to-square-a-leg"),
          ];
      const figure: FigureSpec = {
        kind: "triangle",
        params: asksLeg
          ? { legs: [x, Math.sqrt(radicand)], sideLabels: [withUnit(x), "x", withUnit(hyp)] }
          : { legs: [x, y], sideLabels: [withUnit(x), withUnit(y), "x"] },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            asksLeg
              ? `En un triángulo rectángulo la hipotenusa mide $${hyp}$ ${unit} y un cateto $${x}$ ${unit}. Halla el otro cateto $x$ en forma exacta y simplificada.`
              : `Los catetos de un triángulo rectángulo miden $${x}$ ${unit} y $${y}$ ${unit}. Halla la hipotenusa $x$ en forma exacta y simplificada.`,
          ),
          { figure },
        ],
        correct: surdChoice(radicand, "none"),
        distractors: choices,
        pool: [
          "Teorema de Pitágoras: $c^2 = a^2 + b^2$.",
          asksLeg
            ? `$x^2 = ${hyp}^2 - ${x}^2 = ${radicand}$`
            : `$x^2 = ${x}^2 + ${y}^2 = ${radicand}$`,
          `$x = \\sqrt{${radicand}}$`,
          "Saca de la raíz los factores que son cuadrados perfectos.",
          `La medida exacta (en ${unit}):`,
          surdMath(Rational.one, radicand),
        ],
        numericValues: asksLeg ? [x, hyp] : [x, y],
        problem: asksLeg
          ? { variant, ask: "leg", a: x, b: 0, c: hyp }
          : { variant, ask: "hyp", a: x, b: y, c: 0 },
        fallback: "none",
      });
    }

    const findsLeg = variant === "leg" || variant === "ladder";
    const answer = findsLeg ? b : c;
    const distractors: OptionCandidate[] = findsLeg
      ? [
          surdChoice(c * c + a * a, "added-instead-of-subtracting"),
          numberChoice(c - a, "subtracted-the-sides"),
          numberChoice(c * c - a * a, "forgot-the-square-root"),
        ]
      : [
          numberChoice(a + b, "added-the-legs"),
          numberChoice(a * a + b * b, "forgot-the-square-root"),
          surdChoice(Math.abs(b * b - a * a), "subtracted-the-squares"),
        ];
    let question: string;
    let figure: FigureSpec;
    if (variant === "ladder") {
      question = `Una escalera de $${c}$ ${unit} se apoya en una pared vertical. Su pie está a $${a}$ ${unit} de la pared. ¿A qué altura toca la pared?`;
      figure = rightTriangle([withUnit(a), "?", withUnit(c)], "Escalera apoyada en la pared");
    } else if (variant === "diagonal") {
      question = `Un rectángulo mide $${a}$ ${unit} de base y $${b}$ ${unit} de altura. ¿Cuánto mide su diagonal?`;
      figure = rightTriangle(
        [withUnit(a), withUnit(b), "?"],
        "Mitad de un rectángulo cortado por su diagonal",
      );
    } else if (findsLeg) {
      question = `En el triángulo rectángulo, la hipotenusa mide $${c}$ ${unit} y un cateto $${a}$ ${unit}. ¿Cuánto mide el otro cateto?`;
      figure = rightTriangle([withUnit(a), "?", withUnit(c)]);
    } else {
      question = `Los catetos de un triángulo rectángulo miden $${a}$ ${unit} y $${b}$ ${unit}. ¿Cuánto mide la hipotenusa?`;
      figure = rightTriangle([withUnit(a), withUnit(b), "?"]);
    }
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(question), { figure }],
      correct: numberChoice(answer, "none"),
      distractors,
      pool: [
        "Teorema de Pitágoras: el cuadrado de la hipotenusa es la suma de los cuadrados de los catetos.",
        findsLeg ? `$${c}^2 = ${a}^2 + x^2$` : `$x^2 = ${a}^2 + ${b}^2$`,
        findsLeg
          ? `$x^2 = ${c * c} - ${a * a} = ${c * c - a * a}$`
          : `$x^2 = ${a * a} + ${b * b} = ${c * c}$`,
        findsLeg ? `$x = \\sqrt{${b * b}}$` : `$x = \\sqrt{${c * c}}$`,
        `La medida es (en ${unit}):`,
        math(answer),
      ],
      numericValues: findsLeg ? [a, c] : [a, b],
      problem: { variant, a, b, c },
      fallback: "natural",
    });
  },
};
