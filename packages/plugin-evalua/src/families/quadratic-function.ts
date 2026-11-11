import type { FigureSpec } from "../figures/index.js";
import { latexPoly } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { solutionSet } from "./absolute-value.js";
import { pointChoice, pointMath, pointText } from "./exact.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { polyOfX, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "y-intercept" | "evaluate" | "vertex" | "axis" | "roots" | "extreme" | "read-graph";

/** `a x² + b x + c` from `a`, the vertex `(h, k)`: b = -2ah, c = ah² + k. */
export function standardForm(a: number, h: number, k: number): { a: number; b: number; c: number } {
  return { a, b: -2 * a * h, c: a * h * h + k };
}

const valueAt = (q: { a: number; b: number; c: number }, x: number): number =>
  q.a * x * x + q.b * x + q.c;

const formula = (q: { a: number; b: number; c: number }): string =>
  `f(x) = ${latexPoly(polyOfX([q.c, q.b, q.a]))}`;

const rootsMath = (values: readonly number[]): string =>
  [...new Set(values)]
    .sort((x, y) => x - y)
    .map((value) => `$x = ${value}$`)
    .join(" y ");

const rootsChoice = (values: readonly number[], error: string): OptionCandidate =>
  textChoice(solutionSet(values), error, rootsMath(values));

/**
 * Draws a parabola whose coefficients fit the level: a vertex form with integer `h`, `k` (and
 * integer roots when asked), retried until `|b|` and `|c|` stay inside the coefficient range.
 */
function drawParabola(
  rng: Rng,
  limit: number,
  withRoots: boolean,
  index: number,
): { a: number; h: number; k: number; roots: number[] } {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const a = rng.pick(index === 0 ? [1, -1] : [1, -1, 2, -2]);
    if (withRoots) {
      const r1 = rng.int(-5, 5);
      let r2 = rng.int(-5, 5);
      if ((r1 + r2) % 2 !== 0) r2 += r2 < 5 ? 1 : -1;
      if (r2 === r1) continue;
      const h = (r1 + r2) / 2;
      const k = -a * ((r2 - r1) / 2) ** 2;
      const q = standardForm(a, h, k);
      if (Math.abs(q.b) <= limit && Math.abs(q.c) <= limit) return { a, h, k, roots: [r1, r2] };
      continue;
    }
    const h = rng.int(-4, 4);
    const k = rng.int(-6, 6);
    const q = standardForm(a, h, k);
    if (Math.abs(q.b) <= limit && Math.abs(q.c) <= limit) return { a, h, k, roots: [] };
  }
  return withRoots ? { a: 1, h: 1, k: -1, roots: [0, 2] } : { a: 1, h: 1, k: 2, roots: [] };
}

/** The quadratic function: intercept, values, vertex, axis, roots and extreme value (9th). */
export const quadraticFunction: Family = {
  id: "quadratic-function",
  solve(problem: Record<string, unknown>): Rational | string {
    const a = Number(problem.a);
    const h = Number(problem.h);
    const k = Number(problem.k);
    const q = standardForm(a, h, k);
    switch (problem.variant as Variant) {
      case "y-intercept":
        return Rational.of(q.c);
      case "evaluate":
        return Rational.of(valueAt(q, Number(problem.x)));
      case "axis":
        return Rational.of(h);
      case "roots": {
        // Roots of a(x - h)² + k = 0: h ± √(-k / a), integers by construction.
        const spread = Math.round(Math.sqrt(-k / a));
        return solutionSet([h - spread, h + spread]);
      }
      case "extreme":
        return Rational.of(k);
      default:
        return pointText(h, k);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["y-intercept", "evaluate"],
        ["evaluate", "vertex", "axis"],
        ["vertex", "roots", "extreme", "axis"],
        ["roots", "read-graph", "extreme", "vertex"],
      ]),
    );
    const family = "quadratic-function";
    const limit = Math.max(4, Math.min(60, calibration.coefficientRange[1]));
    const { a, h, k, roots } = drawParabola(rng, limit, variant === "roots", index);
    const q = standardForm(a, h, k);
    const f = formula(q);
    const ask = (text: string) => prompt(rng, prompts, text, `$${f}$`);
    const numericValues = [q.a, q.b, q.c];
    const problem = { variant, a, h, k };

    if (variant === "y-intercept" || variant === "evaluate") {
      const x = variant === "evaluate" ? rng.int(-3, 3) || 2 : 0;
      const answer = valueAt(q, x);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            variant === "evaluate"
              ? `Si {expr}, ¿cuánto vale $f(${x})$?`
              : "¿En qué valor de $y$ corta el eje $y$ la gráfica de {expr}?",
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors:
          variant === "evaluate"
            ? [
                numberChoice(-q.a * x * x + q.b * x + q.c, "squared-the-sign-wrongly"),
                numberChoice(q.a * 2 * x + q.b * x + q.c, "doubled-instead-of-squaring"),
                numberChoice(q.a * x * x - q.b * x + q.c, "sign-error"),
              ]
            : [
                numberChoice(q.a, "gave-the-leading-coefficient"),
                numberChoice(q.b === q.c ? q.c + 1 : q.b, "gave-the-linear-coefficient"),
                numberChoice(-q.c, "sign-error"),
              ],
        pool: [
          variant === "evaluate"
            ? `Reemplaza $x = ${x}$ en la función.`
            : "La gráfica corta el eje $y$ cuando $x = 0$.",
          `$f(${x}) = ${q.a}(${x})^2 ${q.b < 0 ? "-" : "+"} ${Math.abs(q.b)}(${x}) ${q.c < 0 ? "-" : "+"} ${Math.abs(q.c)}$`,
          `$f(${x}) = ${answer}$`,
          "El valor es:",
          math(answer),
        ],
        numericValues,
        problem: { ...problem, x },
        fallback: "any",
      });
    }

    if (variant === "axis" || variant === "extreme") {
      const axis = variant === "axis";
      const opens = a > 0 ? "mínimo" : "máximo";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            axis
              ? "¿Cuál es el eje de simetría $x = ?$ de la parábola {expr}?"
              : `¿Cuál es el valor ${opens} de {expr}?`,
          ),
        ],
        correct: numberChoice(axis ? h : k, "none"),
        distractors: axis
          ? [
              numberChoice(-h === h ? h + 1 : -h, "forgot-the-minus-sign"),
              numberChoice(Rational.of(-q.b, q.a), "forgot-to-halve"),
              numberChoice(q.c, "gave-the-intercept"),
            ]
          : [
              numberChoice(q.c === k ? k + 2 : q.c, "gave-the-intercept"),
              numberChoice(h === k ? -k : h, "gave-the-x-coordinate"),
              numberChoice(-k === k ? k - 1 : -k, "sign-error"),
            ],
        pool: [
          "El vértice está en $x = -\\dfrac{b}{2a}$.",
          `$x = -\\dfrac{${q.b}}{2 \\cdot ${q.a < 0 ? `(${q.a})` : q.a}} = ${h}$`,
          axis ? `El eje de simetría es la recta $x = ${h}$.` : `$f(${h}) = ${k}$`,
          axis ? "El eje es:" : `Como $a ${a > 0 ? "> 0" : "< 0"}$, es el valor ${opens}:`,
          math(axis ? h : k),
        ],
        numericValues,
        problem,
        fallback: "any",
      });
    }

    if (variant === "roots") {
      const [r1, r2] = roots as [number, number];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("¿En qué valores de $x$ corta el eje $x$ la parábola {expr}?")],
        correct: rootsChoice([r1, r2], "none"),
        distractors: [
          rootsChoice([-r1, -r2], "sign-error"),
          rootsChoice([r1, -r2], "one-sign-error"),
          rootsChoice([-r1, r2], "one-sign-error"),
          rootsChoice([h, k], "gave-the-vertex"),
          rootsChoice([r1 + 1, r2 + 1], "shifted-the-roots"),
          rootsChoice([r1 - 1, r2 - 1], "shifted-the-roots"),
          rootsChoice([2 * r1, 2 * r2], "doubled-the-roots"),
        ],
        pool: [
          "Las raíces son los valores de $x$ con $f(x) = 0$.",
          `Factoriza: $${latexPoly(polyOfX([q.c, q.b, q.a]))} = ${a === 1 ? "" : a === -1 ? "-" : a}(x ${r1 < 0 ? "+" : "-"} ${Math.abs(r1)})(x ${r2 < 0 ? "+" : "-"} ${Math.abs(r2)})$`,
          "Un producto es cero si uno de sus factores es cero.",
          "Las raíces son:",
          rootsMath([r1, r2]),
        ],
        numericValues,
        problem,
        fallback: "none",
      });
    }

    // The vertex, from the formula or read from the plotted graph.
    const fromGraph = variant === "read-graph";
    const figure: FigureSpec = {
      kind: "function-plot",
      label: "Gráfica de una parábola",
      params: {
        // A window around the vertex that shows the arms on the side the parabola opens to.
        xMin: Math.min(-1, h - 5),
        xMax: Math.max(1, h + 5),
        yMin: a > 0 ? Math.min(-1, k - 2) : Math.min(-1, k - 10),
        yMax: a > 0 ? Math.max(1, k + 10) : Math.max(1, k + 2),
        yStep: 2,
        curves: [{ type: "polynomial", coefficients: [q.c, q.b, q.a] }],
        points: [{ x: h, y: k, name: "V" }],
      },
    };
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: fromGraph
        ? [
            ask(
              `La gráfica muestra la parábola {expr}. ¿Cuáles son las coordenadas de su vértice V?`,
            ),
            { figure },
          ]
        : [ask("¿Cuál es el vértice de la parábola {expr}?")],
      correct: pointChoice(h, k, "none"),
      distractors: [
        pointChoice(-h, k, "sign-of-h"),
        pointChoice(h, q.c, "used-c-as-k"),
        pointChoice(k, h, "swapped-the-coordinates"),
        pointChoice(-h, -k, "flipped-both-signs"),
        pointChoice(h, -k, "sign-of-k"),
        pointChoice(h, k + q.a, "read-a-neighbour-height"),
        pointChoice(h + 1, k + q.a, "read-a-neighbour-point"),
        pointChoice(h, k - q.a, "sign-of-a"),
      ],
      pool: [
        "La coordenada $x$ del vértice es $h = -\\dfrac{b}{2a}$.",
        `$h = -\\dfrac{${q.b}}{2 \\cdot ${q.a < 0 ? `(${q.a})` : q.a}} = ${h}$`,
        `$k = f(${h}) = ${k}$`,
        "El vértice es:",
        pointMath(h, k),
      ],
      numericValues,
      problem,
      fallback: "none",
    });
  },
};
