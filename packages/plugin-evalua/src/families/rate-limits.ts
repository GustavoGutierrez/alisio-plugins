import type { FigureSpec } from "../figures/index.js";
import { latexPoly } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { polyOfX, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "average-rate"
  | "table-rate"
  | "limit-substitution"
  | "limit-factor"
  | "limit-infinity"
  | "instant-rate"
  | "limit-rationalize"
  | "limit-cubic";

/** `Σ c_i x^i` from ascending coefficients. */
export const evaluate = (coefficients: readonly number[], x: number): number =>
  coefficients.reduceRight((total, coefficient) => total * x + coefficient, 0);

const poly = (coefficients: readonly number[]): string => latexPoly(polyOfX(coefficients));

/** The "it does not exist / 0 over 0" option a student picks when stopping at substitution. */
const indeterminate = (): OptionCandidate =>
  textChoice("indeterminate", "stopped-at-zero-over-zero", "No existe, porque da $\\dfrac{0}{0}$");

/**
 * A window for a function plot holding both points and the curve between them: integer bounds,
 * with a y step that keeps about ten grid rows.
 */
export function plotWindow(coefficients: readonly number[], x1: number, x2: number) {
  const xMin = Math.min(x1, -1) - 1;
  const xMax = Math.max(x2, 1) + 1;
  let low = 0;
  let high = 0;
  for (let x = xMin; x <= xMax; x += 0.25) {
    const y = evaluate(coefficients, x);
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  const y1 = evaluate(coefficients, x1);
  const y2 = evaluate(coefficients, x2);
  const yMin = Math.floor(Math.max(Math.min(low, y1, y2), Math.min(y1, y2) - 12)) - 1;
  const yMax = Math.ceil(Math.min(Math.max(high, y1, y2), Math.max(y1, y2) + 12)) + 1;
  const yStep = Math.max(1, Math.ceil((yMax - yMin) / 10));
  return { xMin, xMax, yMin, yMax, yStep };
}

/** Average rate of change and limits: substitution, factoring, infinity and roots (DBA 10 #6). */
export const rateLimits: Family = {
  id: "rate-limits",
  solve(problem: Record<string, unknown>): Rational | string {
    const coefficients = ((problem.coefficients as unknown[]) ?? []).map(Number);
    const a = Number(problem.a);
    const b = Number(problem.b);
    switch (problem.variant as Variant) {
      case "average-rate":
        return Rational.of(evaluate(coefficients, b) - evaluate(coefficients, a), b - a);
      case "table-rate": {
        const values = (problem.values as unknown[]).map(Number);
        return Rational.of((values[b] ?? 0) - (values[a] ?? 0), b - a);
      }
      case "limit-substitution":
        return Rational.of(evaluate(coefficients, a));
      case "limit-factor":
        // (x - a)(x - b) / (x - a) → a - b as x → a.
        return Rational.of(a - b);
      case "limit-infinity": {
        const top = (problem.top as unknown[]).map(Number);
        const bottom = (problem.bottom as unknown[]).map(Number);
        if (top.length < bottom.length) return Rational.zero;
        return Rational.of(top[top.length - 1] ?? 0, bottom[bottom.length - 1] ?? 1);
      }
      case "instant-rate":
        // s(t) = a t² + b t: the difference quotient tends to 2 a t + b.
        return Rational.of(2 * a * Number(problem.t) + b);
      case "limit-rationalize":
        return Rational.of(1, 2 * a);
      default:
        return Rational.of(3 * a * a);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["average-rate", "table-rate"],
        ["average-rate", "limit-substitution", "limit-factor"],
        ["limit-factor", "limit-infinity", "instant-rate", "average-rate"],
        ["limit-rationalize", "limit-cubic", "limit-infinity", "instant-rate"],
      ]),
    );
    const family = "rate-limits";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const limit = calibration.coefficientRange[1];

    if (variant === "average-rate") {
      const lead = rng.pick(index === 0 ? [1, -1] : [1, -1, 2, -2]);
      const linear = rng.int(-4, 4);
      const constant = rng.int(-5, 5);
      const coefficients = [constant, linear, lead];
      const x1 = rng.int(-3, 2);
      const x2 = x1 + rng.int(1, 3);
      const y1 = evaluate(coefficients, x1);
      const y2 = evaluate(coefficients, x2);
      const slope = Rational.of(y2 - y1, x2 - x1);
      // The secant through A and B: y = y1 + m (x - x1), as ascending coefficients.
      const m = slope.toNumber();
      const secant = [y1 - m * x1, m];
      const figure: FigureSpec = {
        kind: "function-plot",
        label: "Recta secante a la gráfica de f",
        params: {
          ...plotWindow(coefficients, x1, x2),
          curves: [
            { type: "polynomial", coefficients },
            { type: "polynomial", coefficients: secant },
          ],
          points: [
            { x: x1, y: y1, name: "A" },
            { x: x2, y: y2, name: "B" },
          ],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Para $f(x) = ${poly(coefficients)}$, ¿cuál es la razón de cambio promedio entre $x = ${x1}$ y $x = ${x2}$ (la pendiente de la secante $AB$)?`,
          ),
          { figure },
        ],
        correct: numberChoice(slope, "none"),
        distractors: [
          numberChoice(y2 - y1, "forgot-to-divide"),
          numberChoice(slope.neg(), "subtracted-in-the-wrong-order"),
          numberChoice(Rational.of(y2 + y1, x2 - x1), "added-the-values"),
          ...(y2 === y1
            ? []
            : [numberChoice(Rational.of(x2 - x1, y2 - y1), "inverted-the-quotient")]),
        ],
        pool: [
          "Razón de cambio promedio: $\\dfrac{f(b) - f(a)}{b - a}$.",
          `$f(${x1}) = ${y1}$ y $f(${x2}) = ${y2}$.`,
          `$\\dfrac{${y2} - (${y1})}{${x2} - (${x1})} = \\dfrac{${y2 - y1}}{${x2 - x1}}$`,
          "Es la pendiente de la recta secante que une $A$ y $B$.",
          "La razón de cambio promedio es:",
          math(slope),
        ],
        numericValues: [lead, linear, constant, x1, x2],
        problem: { variant, coefficients, a: x1, b: x2 },
        fallback: "any",
      });
    }

    if (variant === "table-rate") {
      const start = rng.int(1, 2);
      const values = [start];
      for (let week = 1; week <= 4; week += 1)
        values.push(Math.min(9, (values[week - 1] ?? 0) + rng.int(0, 2)));
      const a = rng.int(0, 2);
      const b = rng.int(a + 2, 4);
      const answer = Rational.of((values[b] ?? 0) - (values[a] ?? 0), b - a);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `La tabla muestra la altura de una planta cada semana. ¿Cuál fue su crecimiento promedio, en centímetros por semana, entre la semana $${a}$ y la semana $${b}$?`,
          ),
          {
            table: {
              head: ["Semana", ...values.map((_, week) => `$${week}$`)],
              rows: [["Altura (cm)", ...values.map((value) => `$${value}$`)]],
            },
          },
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice((values[b] ?? 0) - (values[a] ?? 0), "forgot-to-divide"),
          numberChoice(Rational.of(values[b] ?? 0, b === 0 ? 1 : b), "divided-the-final-value"),
          numberChoice(Rational.of((values[b] ?? 0) + (values[a] ?? 0), b - a), "added-the-values"),
        ],
        pool: [
          "Razón de cambio promedio: cambio de altura sobre cambio de tiempo.",
          `Altura en la semana $${a}$: $${values[a]}$ cm; en la semana $${b}$: $${values[b]}$ cm.`,
          `$\\dfrac{${values[b]} - ${values[a]}}{${b} - ${a}}$`,
          "El crecimiento promedio (cm por semana) es:",
          math(answer),
        ],
        numericValues: values,
        problem: { variant, values, a, b },
        fallback: "any",
      });
    }

    if (variant === "limit-substitution") {
      const a = rng.int(-3, 3) || 2;
      const coefficients = [rng.int(-6, 6), rng.int(-5, 5), rng.pick([1, -1, 2, -2, 3])];
      const answer = evaluate(coefficients, a);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(`Calcula $\\displaystyle\\lim_{x \\to ${a}} \\left(${poly(coefficients)}\\right)$.`),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(evaluate(coefficients, -a), "sign-error"),
          numberChoice(evaluate(coefficients, 0), "evaluated-at-zero"),
          numberChoice(
            evaluate(coefficients, a) - 2 * (coefficients[0] ?? 0),
            "dropped-the-constant-sign",
          ),
          indeterminate(),
        ],
        pool: [
          "Un polinomio es continuo: el límite es el valor del polinomio.",
          `Reemplaza $x = ${a}$.`,
          `$${poly(coefficients).replace(/x/g, `(${a})`)}$`,
          "Opera respetando la jerarquía.",
          "El límite es:",
          math(answer),
        ],
        numericValues: [...coefficients, a],
        problem: { variant, coefficients, a },
        fallback: "any",
      });
    }

    if (variant === "limit-factor") {
      const a = rng.int(-5, 5) || 3;
      let b = rng.int(-5, 5);
      if (b === a) b = a === 5 ? -5 : a + 1;
      // The written coefficients a·b and a + b stay inside the level range.
      while (Math.abs(a * b) > limit) b += b > 0 ? -1 : 1;
      if (b === a) b = 0;
      // (x - a)(x - b) = x² - (a + b) x + a b.
      const numerator = [a * b, -(a + b), 1];
      const answer = a - b;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Calcula $\\displaystyle\\lim_{x \\to ${a}} \\dfrac{${poly(numerator)}}{${poly([-a, 1])}}$.`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          indeterminate(),
          numberChoice(b - a, "sign-error"),
          numberChoice(a + b, "kept-the-sum-of-roots"),
          numberChoice(-b, "dropped-the-substitution"),
        ],
        pool: [
          `Al sustituir $x = ${a}$ queda $\\dfrac{0}{0}$: hay que simplificar.`,
          `Factoriza el numerador: $${poly(numerator)} = ${poly([-a, 1]).replace(/^/, "(")})${b === 0 ? "x" : `(${poly([-b, 1])})`}$.`,
          `Cancela el factor $${poly([-a, 1])}$ (vale porque $x \\neq ${a}$).`,
          `$\\displaystyle\\lim_{x \\to ${a}} ${b === 0 ? "x" : `\\left(${poly([-b, 1])}\\right)`} = ${a} - (${b})$`,
          "El límite es:",
          math(answer),
        ],
        numericValues: [a * b, a + b, a],
        problem: { variant, a, b },
        fallback: "any",
      });
    }

    if (variant === "limit-infinity") {
      const degree = rng.int(1, 3);
      const lower = rng.int(0, 2) === 0;
      const lead = rng.int(1, 9) * rng.pick([1, -1]);
      const leadBottom = rng.int(2, 9);
      // Ascending coefficients: the constant, the middle terms, then the leading coefficient.
      const build = (size: number, leading: number, constant: number): number[] =>
        size === 0
          ? [leading]
          : [constant, ...Array.from({ length: size - 1 }, () => rng.int(-5, 5)), leading];
      const top = build(lower ? degree - 1 : degree, lead, rng.int(-9, 9));
      const bottom = build(degree, leadBottom, rng.int(1, 9));
      const answer = top.length < bottom.length ? Rational.zero : Rational.of(lead, leadBottom);
      const constants = Rational.of(top[0] ?? 0, bottom[0] ?? 1);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Calcula $\\displaystyle\\lim_{x \\to \\infty} \\dfrac{${poly(top)}}{${poly(bottom)}}$.`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          textChoice("inf", "assumed-it-grows-without-bound", "$\\infty$"),
          numberChoice(constants, "used-the-constant-terms"),
          numberChoice(Rational.of(leadBottom, lead), "inverted-the-leading-coefficients"),
          numberChoice(Rational.of(lead, leadBottom), "compared-unequal-degrees"),
          numberChoice(Rational.one, "assumed-the-limit-is-one"),
          numberChoice(answer.neg(), "sign-error"),
          numberChoice(lead, "gave-the-leading-coefficient"),
        ],
        pool: [
          "Divide numerador y denominador por la mayor potencia de $x$ del denominador.",
          "Los términos con $x$ en el denominador tienden a $0$.",
          top.length < bottom.length
            ? "El numerador tiene menor grado: el cociente tiende a $0$."
            : `Los grados son iguales: queda el cociente de los coeficientes principales, $\\dfrac{${lead}}{${leadBottom}}$.`,
          "El límite es:",
          math(answer),
        ],
        numericValues: [...top, ...bottom],
        problem: { variant, top, bottom },
        fallback: "none",
      });
    }

    if (variant === "instant-rate") {
      const a = rng.int(1, 5);
      const b = rng.int(-6, 9);
      const t = rng.int(1, 5);
      const answer = 2 * a * t + b;
      const position = a * t * t + b * t;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `La posición de un móvil es $s(t) = ${poly([0, b, a]).replace(/x/g, "t")}$ (en metros, $t$ en segundos). Con $\\displaystyle\\lim_{h \\to 0} \\dfrac{s(${t} + h) - s(${t})}{h}$, halla su velocidad instantánea en $t = ${t}$.`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(a * t + b, "used-the-average-rate-from-zero"),
          numberChoice(position, "gave-the-position"),
          numberChoice(2 * a * t, "dropped-the-linear-term"),
          numberChoice(a * t * t, "kept-the-square"),
        ],
        pool: [
          `$s(${t} + h) = ${a}(${t} + h)^2 ${b < 0 ? "-" : "+"} ${Math.abs(b)}(${t} + h)$`,
          `$s(${t} + h) - s(${t}) = ${2 * a * t + b}h + ${a}h^2$`,
          `Divide entre $h$: $${2 * a * t + b} + ${a}h$.`,
          "Cuando $h \\to 0$ el término con $h$ desaparece.",
          "La velocidad instantánea (m/s) es:",
          math(answer),
        ],
        numericValues: [a, b, t],
        problem: { variant, a, b, t },
        fallback: "any",
      });
    }

    if (variant === "limit-rationalize") {
      const a = rng.int(1, Math.min(7, Math.floor(Math.sqrt(limit))));
      const square = a * a;
      const answer = Rational.of(1, 2 * a);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Calcula $\\displaystyle\\lim_{x \\to ${square}} \\dfrac{\\sqrt{x} - ${a}}{x - ${square}}$.`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          indeterminate(),
          numberChoice(Rational.of(1, a), "forgot-the-factor-two"),
          numberChoice(2 * a, "inverted-the-result"),
          numberChoice(Rational.of(1, square), "used-the-square"),
        ],
        pool: [
          `Al sustituir queda $\\dfrac{0}{0}$.`,
          `Factoriza la diferencia de cuadrados: $x - ${square} = (\\sqrt{x} - ${a})(\\sqrt{x} + ${a})$.`,
          `Simplifica: $\\dfrac{1}{\\sqrt{x} + ${a}}$.`,
          `Sustituye $x = ${square}$: $\\dfrac{1}{${a} + ${a}}$.`,
          "El límite es:",
          math(answer),
        ],
        numericValues: [a, square],
        problem: { variant, a },
        fallback: "none",
      });
    }

    // limit-cubic: (x³ - a³)/(x - a) → 3a².
    const a = rng.int(-3, 3) || 2;
    const cube = a ** 3;
    const answer = 3 * a * a;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `Calcula $\\displaystyle\\lim_{x \\to ${a}} \\dfrac{${poly([-cube, 0, 0, 1])}}{${poly([-a, 1])}}$.`,
        ),
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        indeterminate(),
        numberChoice(a * a, "forgot-a-term-of-the-factorization"),
        numberChoice(3 * a, "lowered-the-power-wrongly"),
        numberChoice(2 * a * a, "factored-as-a-square"),
      ],
      pool: [
        "Al sustituir queda $\\dfrac{0}{0}$.",
        `Diferencia de cubos: $x^3 - ${cube < 0 ? `(${cube})` : cube} = (x - ${a < 0 ? `(${a})` : a})(x^2 + ${a < 0 ? `(${a})` : a}x + ${a * a})$.`,
        "Cancela el factor común.",
        `Sustituye: $${a * a} + ${a * a} + ${a * a}$.`,
        "El límite es:",
        math(answer),
      ],
      numericValues: [cube, a],
      problem: { variant, a },
      fallback: "any",
    });
  },
};
