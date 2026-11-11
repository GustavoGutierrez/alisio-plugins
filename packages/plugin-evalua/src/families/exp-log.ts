import type { FigureSpec } from "../figures/index.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "evaluate" | "log-value" | "growth" | "solve-exp" | "log-rules" | "base-from-graph";
type Rule = "product" | "quotient" | "power";

/** `base^exponent` for any integer exponent, exact. */
export const intPower = (base: Rational, exponent: number): Rational =>
  exponent >= 0 ? base.pow(exponent) : base.inv().pow(-exponent);

const paren = (value: Rational | number): string => {
  const text = latexRational(Rational.from(value));
  return text.startsWith("-") ? `(${text})` : text;
};

const GROWTH = [
  { what: "bacterias", base: 2, verb: "se duplica", period: "hora" },
  { what: "seguidores", base: 3, verb: "se triplica", period: "semana" },
  { what: "algas", base: 2, verb: "se duplica", period: "día" },
];

/** Exponential functions and logarithms: values, growth, equations and the rules (9-10). */
export const expLog: Family = {
  id: "exp-log",
  solve(problem: Record<string, unknown>): Rational {
    const base = Number(problem.base);
    const k = Number(problem.k);
    const j = Number(problem.j);
    switch (problem.variant as Variant) {
      case "evaluate":
        return Rational.of(Number(problem.a)).mul(intPower(Rational.of(base), k));
      case "growth":
        return Rational.of(Number(problem.a) * base ** k);
      case "log-value":
        return Rational.of(k);
      case "solve-exp":
        return Rational.of(k - j);
      case "log-rules": {
        const rule = problem.rule as Rule;
        return Rational.of(rule === "product" ? k + j : rule === "quotient" ? k - j : k * j);
      }
      default:
        return Rational.of(base);
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["evaluate", "log-value"],
        ["evaluate", "log-value", "growth"],
        ["solve-exp", "log-rules", "base-from-graph", "log-value"],
        ["log-rules", "solve-exp", "base-from-graph", "growth"],
      ]),
    );
    const family = "exp-log";
    const ask = (text: string, expr = "") => prompt(rng, prompts, text, expr);
    const base = rng.pick(index === 0 ? [2, 3, 10] : [2, 3, 4, 5, 10]);
    const b = Rational.of(base);

    if (variant === "evaluate") {
      const a = index === 0 ? rng.pick([1, 2, 3]) : rng.pick([1, 2, 3, -2]);
      const x = index === 0 ? rng.int(0, 3) : rng.int(-3, 3);
      const answer = Rational.of(a).mul(intPower(b, x));
      const fx = `f(x) = ${a === 1 ? "" : `${a} \\cdot `}${base}^{x}`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Si $${fx}$, ¿cuánto vale $f(${x})$?`)],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(a * base * x), "multiplied-by-the-exponent"),
          numberChoice(intPower(Rational.of(a * base), x), "multiplied-before-the-power"),
          x < 0
            ? numberChoice(Rational.of(a).mul(intPower(b, -x)).neg(), "made-the-power-negative")
            : numberChoice(Rational.of(a).mul(intPower(b, x + 1)), "one-factor-too-many"),
          numberChoice(Rational.of(a).mul(intPower(b, x - 1)), "one-factor-too-few"),
        ],
        pool: [
          "Reemplaza $x$ por el valor dado.",
          `$f(${x}) = ${a === 1 ? "" : `${a} \\cdot `}${base}^{${x}}$`,
          x < 0
            ? `Un exponente negativo invierte: $${base}^{${x}} = \\dfrac{1}{${base}^{${-x}}}$.`
            : `$${base}^{${x}} = ${latexRational(intPower(b, x))}$`,
          `$f(${x}) = ${latexRational(answer)}$`,
          "El valor es:",
          math(answer),
        ],
        numericValues: [a, x],
        problem: { variant, a, base, k: x, j: 0 },
        fallback: "any",
      });
    }

    if (variant === "log-value") {
      const k = index === 0 ? rng.int(1, 4) : rng.int(-3, 5);
      const argument = intPower(b, k);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("Calcula: {expr}", `$\\log_{${base}} ${paren(argument)}$`)],
        correct: numberChoice(k, "none"),
        distractors: [
          numberChoice(-k === k ? k + 1 : -k, "flipped-the-sign"),
          numberChoice(
            argument.isInteger() && argument.compare(Rational.of(60)) <= 0
              ? argument.div(b)
              : Rational.of(k + 1),
            "divided-by-the-base",
          ),
          numberChoice(k + 1, "counted-one-more-factor"),
          numberChoice(k - 1, "counted-one-less-factor"),
        ],
        pool: [
          `$\\log_{${base}} N$ es el exponente al que hay que elevar $${base}$ para obtener $N$.`,
          `$${base}^{${k}} = ${latexRational(argument)}$`,
          `Entonces $\\log_{${base}} ${paren(argument)} = ${k}$.`,
          "El logaritmo es:",
          math(k),
        ],
        numericValues: [k],
        problem: { variant, base, k, j: 0 },
        fallback: "any",
      });
    }

    if (variant === "growth") {
      const story = rng.pick(GROWTH);
      const start = rng.pick([5, 10, 20, 50, 100]);
      const t = rng.int(2, 5);
      const answer = start * story.base ** t;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Una población de $${start}$ ${story.what} ${story.verb} cada ${story.period}. ¿Cuántos habrá después de $${t}$ periodos de una ${story.period}?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(start * story.base * t, "linear-growth"),
          numberChoice(start + story.base ** t, "added-instead"),
          numberChoice(start * story.base ** (t - 1), "one-period-short"),
        ],
        pool: [
          `Cada periodo la cantidad se multiplica por $${story.base}$.`,
          `$P(t) = ${start} \\cdot ${story.base}^{t}$`,
          `$P(${t}) = ${start} \\cdot ${story.base ** t}$`,
          "La población final es:",
          math(answer),
        ],
        numericValues: [story.base, t],
        problem: { variant, a: start, base: story.base, k: t, j: 0 },
        fallback: "natural",
      });
    }

    if (variant === "solve-exp") {
      const k = rng.int(2, base === 10 ? 4 : 5);
      const j = rng.int(-3, 3) || 1;
      const value = base ** k;
      const shift = j < 0 ? `x - ${-j}` : `x + ${j}`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("Resuelve la ecuación: {expr}", `$${base}^{${shift}} = ${value}$`)],
        correct: numberChoice(k - j, "none"),
        distractors: [
          numberChoice(k + j, "moved-the-term-with-the-wrong-sign"),
          numberChoice(k, "ignored-the-shift"),
          numberChoice(
            Rational.of(value, base).sub(Rational.of(j)),
            "divided-instead-of-taking-the-log",
          ),
        ],
        pool: [
          `Escribe $${value}$ como potencia de $${base}$: $${value} = ${base}^{${k}}$.`,
          `$${base}^{${shift}} = ${base}^{${k}}$`,
          `Iguala los exponentes: $${shift} = ${k}$.`,
          `$x = ${k - j}$`,
          "La solución es:",
          math(k - j),
        ],
        numericValues: [base, k, j],
        problem: { variant, base, k, j },
        fallback: "any",
      });
    }

    if (variant === "log-rules") {
      const rule = rng.pick<Rule>(["product", "quotient", "power"]);
      const k = rng.int(1, 4);
      const j = rng.int(1, rule === "power" ? 3 : 4);
      const m = base ** k;
      const n = base ** j;
      const expr =
        rule === "product"
          ? `\\log_{${base}} ${m} + \\log_{${base}} ${n}`
          : rule === "quotient"
            ? `\\log_{${base}} ${m} - \\log_{${base}} ${n}`
            : `\\log_{${base}} \\left(${m}^{${j}}\\right)`;
      const answer = rule === "product" ? k + j : rule === "quotient" ? k - j : k * j;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("Calcula usando las propiedades de los logaritmos: {expr}", `$${expr}$`)],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(
            rule === "product" ? k * j : rule === "quotient" ? k + j : k + j,
            "used-the-wrong-rule",
          ),
          numberChoice(
            rule === "power" ? m * j : rule === "product" ? m + n : m - n,
            "operated-on-the-arguments",
          ),
          numberChoice(
            rule === "quotient" ? j - k : answer + 1,
            rule === "quotient" ? "subtracted-backwards" : "counted-one-more-factor",
          ),
        ],
        pool: [
          rule === "product"
            ? "$\\log_b M + \\log_b N = \\log_b (M N)$"
            : rule === "quotient"
              ? "$\\log_b M - \\log_b N = \\log_b \\dfrac{M}{N}$"
              : "$\\log_b (M^p) = p \\log_b M$",
          `$\\log_{${base}} ${m} = ${k}$${rule === "power" ? "" : ` y $\\log_{${base}} ${n} = ${j}$`}`,
          rule === "product"
            ? `$${k} + ${j}$`
            : rule === "quotient"
              ? `$${k} - ${j}$`
              : `$${j} \\cdot ${k}$`,
          "El resultado es:",
          math(answer),
        ],
        numericValues: [k, j],
        problem: { variant, base, k, j, rule },
        fallback: "any",
      });
    }

    // Read the base of y = b^x from a marked point (2, b²) on its graph.
    const graphBase = rng.pick([2, 3, 4]);
    const px = graphBase === 2 ? rng.pick([2, 3]) : 2;
    const py = graphBase ** px;
    const top = Math.ceil((py + 2) / 2) * 2;
    const figure: FigureSpec = {
      kind: "function-plot",
      label: "Gráfica de una función exponencial",
      params: {
        xMin: -3,
        xMax: 4,
        yMin: 0,
        yMax: top,
        yStep: top > 12 ? 2 : 1,
        curves: [{ type: "exponential", a: 1, base: graphBase }],
        points: [
          { x: 0, y: 1, name: "" },
          { x: px, y: py, name: `(${px}, ${py})` },
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
          `La gráfica es de $f(x) = b^{x}$ y pasa por el punto $(${px}, ${py})$. ¿Cuál es la base $b$?`,
        ),
        { figure },
      ],
      correct: numberChoice(graphBase, "none"),
      distractors: [
        numberChoice(py, "read-the-y-value"),
        numberChoice(Rational.of(py, px), "divided-by-x"),
        numberChoice(graphBase + 1, "misread-the-graph"),
        numberChoice(px, "read-the-x-value"),
      ],
      pool: [
        "La función $f(x) = b^{x}$ pasa por $(0, 1)$ para cualquier base.",
        `En el punto marcado $f(${px}) = ${py}$.`,
        `$b^{${px}} = ${py}$`,
        `$b = ${graphBase}$`,
        "La base es:",
        math(graphBase),
      ],
      numericValues: [px, py],
      problem: { variant, base: graphBase, k: px, j: 0 },
      fallback: "natural",
    });
  },
};
