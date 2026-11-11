import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import {
  distinctInts,
  finishDraft,
  levelIndex,
  math,
  numberChoice,
  textChoice,
  tier,
} from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt, rangeValue } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "value" | "which-numbers" | "largest" | "distance" | "expression" | "equation";
type Form = "sum" | "difference" | "inside" | "negated";

/** Canonical text of a solution set: the values sorted and joined, `{-3,7}`. */
export const solutionSet = (values: readonly number[]): string =>
  `{${[...new Set(values)].sort((a, b) => a - b).join(",")}}`;

const setMath = (values: readonly number[]): string => {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  return sorted.map((value) => `$x = ${value}$`).join(" y ");
};

const setChoice = (values: readonly number[], error: string): OptionCandidate =>
  textChoice(solutionSet(values), error, setMath(values));

function evaluate(form: Form, a: number, b: number): number {
  switch (form) {
    case "sum":
      return Math.abs(a) + Math.abs(b);
    case "difference":
      return Math.abs(a) - Math.abs(b);
    case "inside":
      return Math.abs(a - b);
    default:
      return -Math.abs(a);
  }
}

const formMath = (form: Form, a: number, b: number): string => {
  const wrap = (value: number) => (value < 0 ? `(${value})` : `${value}`);
  switch (form) {
    case "sum":
      return `|${a}| + |${b}|`;
    case "difference":
      return `|${a}| - |${b}|`;
    case "inside":
      return `|${a} - ${wrap(b)}|`;
    default:
      return `-|${a}|`;
  }
};

/** A number line wide enough for every value, with a tick step that keeps the labels readable. */
function lineFor(values: readonly number[]): { min: number; max: number; step: number } {
  const reach = Math.max(2, ...values.map((value) => Math.abs(value)));
  const step = reach <= 10 ? 1 : reach <= 25 ? 5 : 10;
  const bound = Math.ceil((reach + 1) / step) * step;
  return { min: -bound, max: bound, step };
}

/** Absolute value as distance to zero on the number line, and simple |x - h| = k (DBA 6 #3). */
export const absoluteValue: Family = {
  id: "absolute-value",
  solve(problem: Record<string, unknown>): Rational | string {
    const a = Number(problem.a);
    const b = Number(problem.b);
    switch (problem.variant as Variant) {
      case "value":
        return Rational.of(Math.abs(a));
      case "which-numbers":
        return solutionSet([-a, a]);
      case "largest": {
        const values = (problem.values as unknown[]).map(Number);
        const best = values.reduce((top, value) => (Math.abs(value) > Math.abs(top) ? value : top));
        return Rational.of(best);
      }
      case "distance":
        return Rational.of(Math.abs(a - b));
      case "expression":
        return Rational.of(evaluate(problem.form as Form, a, b));
      default:
        return solutionSet([a - b, a + b]);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["value", "which-numbers", "largest"],
        ["value", "largest", "distance", "expression"],
        ["distance", "expression", "equation"],
        ["expression", "equation", "distance"],
      ]),
    );
    const range = calibration.coefficientRange;
    const a = rangeValue(rng, range, { minMagnitude: 2 });
    let b = rangeValue(rng, range, { minMagnitude: 1 });
    // |b| = |a| would make several distractors coincide; one step towards zero never reaches it.
    if (Math.abs(b) === Math.abs(a)) b += b > 0 ? -1 : 1;
    const family = "absolute-value";

    if (variant === "largest") {
      // Four different distances to zero; the farthest number is negative, so "the biggest number"
      // and "the biggest absolute value" never agree.
      const high = Math.max(5, Math.min(range[1], -range[0]));
      const sizes = distinctInts(rng, 4, 1, high).sort((x, y) => y - x);
      const values = sizes.map((size, position) =>
        position === 0 ? -size : rng.int(0, 1) === 0 ? size : -size,
      );
      if (values.every((value, position) => position === 0 || value < 0)) {
        values[1] = Math.abs(values[1] ?? 1);
      }
      const shown = rng.shuffle(values);
      const answer = values[0] ?? 0;
      const largestSigned = Math.max(...values);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `¿Cuál de estos números tiene el mayor valor absoluto? ${shown.map((value) => `$${value}$`).join(", ")}`,
            "",
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: values
          .slice(1)
          .map((value) =>
            numberChoice(
              value,
              value === largestSigned ? "picked-the-largest-number" : "compared-without-bars",
            ),
          ),
        pool: [
          "El valor absoluto es la distancia al cero, sin importar el signo.",
          `Valores absolutos: ${shown.map((value) => `$|${value}| = ${Math.abs(value)}$`).join(", ")}.`,
          `La mayor distancia al cero es $${Math.abs(answer)}$.`,
          "El número es:",
          math(answer),
        ],
        numericValues: values,
        problem: { variant, values, a: 0, b: 0 },
        fallback: "none",
      });
    }

    if (variant === "value") {
      const value = rng.int(0, 2) === 0 ? Math.abs(a) : -Math.abs(a);
      const figure: FigureSpec = {
        kind: "number-line",
        params: { ...lineFor([value]), points: [{ value, name: "A" }] },
      };
      const size = Math.abs(value);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(rng, prompts, `El punto A está en $${value}$. ¿Cuánto es $|${value}|$?`, ""),
          { figure },
        ],
        correct: numberChoice(size, "none"),
        distractors: [
          numberChoice(-size, value < 0 ? "kept-the-sign" : "changed-the-sign"),
          numberChoice(size + 1, "counted-the-marks"),
          numberChoice(2 * size, "doubled-the-distance"),
        ],
        pool: [
          "El valor absoluto es la distancia de un número al cero.",
          `De $${value}$ a $0$ hay $${size}$ unidades.`,
          "Una distancia nunca es negativa.",
          "El valor absoluto es:",
          math(size),
        ],
        numericValues: [value],
        problem: { variant, a: value, b: 0 },
        fallback: "none",
      });
    }

    if (variant === "which-numbers") {
      const size = Math.abs(a);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, `¿Qué números cumplen $|x| = ${size}$?`, "")],
        correct: setChoice([-size, size], "none"),
        distractors: [
          setChoice([size], "forgot-the-negative"),
          setChoice([-size], "only-the-negative"),
          setChoice([0, size], "included-zero"),
        ],
        pool: [
          "El valor absoluto es la distancia al cero.",
          `Hay dos números a $${size}$ unidades del cero: uno a cada lado.`,
          `$|${size}| = ${size}$ y $|-${size}| = ${size}$`,
          "Los números son:",
          setMath([-size, size]),
        ],
        numericValues: [size],
        problem: { variant, a: size, b: 0 },
      });
    }

    if (variant === "distance") {
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const answer = right - left;
      const figure: FigureSpec = {
        kind: "number-line",
        params: {
          ...lineFor([a, b]),
          points: [
            { value: a, name: "P" },
            { value: b, name: "Q" },
          ],
          span: [a, b],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `En la recta, P está en $${a}$ y Q en $${b}$. ¿Cuál es la distancia entre P y Q?`,
            "",
          ),
          { figure },
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Math.abs(Math.abs(a) - Math.abs(b)), "subtracted-the-absolute-values"),
          numberChoice(Math.abs(a + b), "added-the-numbers"),
          numberChoice(-answer, "negative-distance"),
          numberChoice(answer + 1, "counted-the-marks"),
        ],
        pool: [
          "La distancia entre dos puntos es el valor absoluto de su diferencia.",
          `$d = |${a} - ${b < 0 ? `(${b})` : b}|$`,
          `$d = |${a - b}|$`,
          `$d = ${answer}$`,
          "La distancia es:",
          math(answer),
        ],
        numericValues: [a, b],
        problem: { variant, a, b },
        fallback: "any",
      });
    }

    if (variant === "expression") {
      const form = rng.pick<Form>(
        index <= 1 ? ["sum", "difference", "negated"] : ["sum", "difference", "inside"],
      );
      const answer = evaluate(form, a, b);
      const wrong: OptionCandidate[] = [
        numberChoice(form === "negated" ? Math.abs(a) : -answer, "ignored-the-outer-sign"),
        numberChoice(
          form === "inside" ? Math.abs(a) - Math.abs(b) : form === "negated" ? a : a + b,
          "dropped-the-bars",
        ),
        numberChoice(
          form === "inside" ? Math.abs(a) + Math.abs(b) : form === "sum" ? a - b : a - b,
          "mixed-up-the-signs",
        ),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, "Calcula: {expr}", `$${formMath(form, a, b)}$`)],
        correct: numberChoice(answer, "none"),
        distractors: wrong,
        pool: [
          "Primero resuelve lo que está dentro de las barras.",
          form === "inside"
            ? `$${a} - ${b < 0 ? `(${b})` : b} = ${a - b}$`
            : `$|${a}| = ${Math.abs(a)}$${form === "negated" ? "" : ` y $|${b}| = ${Math.abs(b)}$`}`,
          "Luego opera con los valores absolutos.",
          `$${formMath(form, a, b)} = ${answer}$`,
          "El resultado es:",
          math(answer),
        ],
        numericValues: [a, b],
        problem: { variant, form, a, b },
        fallback: "any",
      });
    }

    // |x - h| = k: two solutions, h - k and h + k.
    const h = a;
    const k = Math.abs(b);
    const inside = h < 0 ? `x + ${-h}` : `x - ${h}`;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, "Resuelve la ecuación: {expr}", `$|${inside}| = ${k}$`)],
      correct: setChoice([h - k, h + k], "none"),
      distractors: [
        setChoice([h + k], "ignored-the-negative-case"),
        setChoice([-h - k, k - h], "moved-the-term-with-the-wrong-sign"),
        setChoice([-k, k], "ignored-the-shift"),
        setChoice([-(h + k), h + k], "mirrored-one-solution"),
      ],
      pool: [
        "Un valor absoluto igual a $k$ da dos casos: $k$ y $-k$.",
        `Caso 1: $${inside} = ${k}$, entonces $x = ${h + k}$.`,
        `Caso 2: $${inside} = -${k}$, entonces $x = ${h - k}$.`,
        "Comprueba cada solución en la ecuación.",
        "Las soluciones son:",
        setMath([h - k, h + k]),
      ],
      numericValues: [h, k],
      problem: { variant, a: h, b: k },
      fallback: "none",
    });
  },
};
