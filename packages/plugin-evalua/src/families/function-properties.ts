import type { FigureSpec } from "../figures/index.js";
import { Poly } from "../math/poly.js";
import { Rational } from "../math/rational.js";
import {
  complement,
  intervalChoice,
  intervalLatex,
  intervalText,
  type Span,
  span,
} from "./intervals.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { linearText, polyDisplay, polyOfX, polyValue, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "composition-value"
  | "inverse-linear"
  | "composition-formula"
  | "domain"
  | "range"
  | "inverse-value"
  | "domain-combined";

type DomainForm = "root-right" | "root-left" | "reciprocal" | "root-denominator";

/** `m x + n` with rational coefficients, as a polynomial. */
const linear = (m: Rational, n: Rational): Poly =>
  Poly.constant(m).mul(Poly.variable("x")).add(Poly.constant(n));

const polyChoice = (poly: Poly, error: string, prefix = ""): OptionCandidate => ({
  value: polyValue(poly),
  display: `$${prefix}${polyDisplay(poly).slice(1, -1)}$`,
  error,
});

/** ` + 5`, ` - 5` or nothing for zero: a trailing constant term. */
const constantText = (value: number): string =>
  value === 0 ? "" : ` ${value < 0 ? "-" : "+"} ${Math.abs(value)}`;

/** The domain of each form, with `a` the critical value (and `b` the excluded one). */
function domainOf(form: DomainForm, a: number, b: number): Span[] {
  switch (form) {
    case "root-right":
      return [span(a, null, true)];
    case "root-left":
      return [span(null, a, false, true)];
    case "reciprocal":
      return [span(null, a), span(a, null)];
    default:
      // √(x - a) / (x - b) with b > a: x ≥ a and x ≠ b.
      return [span(a, b, true, false), span(b, null)];
  }
}

function domainLatex(form: DomainForm, a: number, b: number): string {
  const minus = (value: number) => linearText(1, -value);
  switch (form) {
    case "root-right":
      return `\\sqrt{${minus(a)}}`;
    case "root-left":
      return `\\sqrt{${linearText(-1, a)}}`;
    case "reciprocal":
      return `\\dfrac{1}{${minus(a)}}`;
    default:
      return `\\dfrac{\\sqrt{${minus(a)}}}{${minus(b)}}`;
  }
}

/** Domain, range, composition and inverse of functions (MEN EBC 10-11, pensamiento variacional). */
export const functionProperties: Family = {
  id: "function-properties",
  solve(problem: Record<string, unknown>): Rational | string {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    const d = Number(problem.d);
    switch (problem.variant as Variant) {
      case "composition-value": {
        // f(x) = a x + b, g(x) = x² + d.
        const x0 = Number(problem.x0);
        const f = (x: number) => a * x + b;
        const g = (x: number) => x * x + d;
        return Rational.of(problem.order === "fg" ? f(g(x0)) : g(f(x0)));
      }
      case "inverse-linear":
        // y = a x + b ⇒ x = (y - b) / a.
        return polyValue(linear(Rational.of(1, a), Rational.of(-b, a)));
      case "composition-formula":
        // f(x) = x² + b, g(x) = c x + d: f(g(x)) = (c x + d)² + b.
        return polyValue(polyOfX([d * d + b, 2 * c * d, c * c]));
      case "domain":
      case "domain-combined":
        return intervalText(domainOf(problem.form as DomainForm, a, b));
      case "range":
        return intervalText([a > 0 ? span(c, null, true) : span(null, c, false, true)]);
      default: {
        // f(x) = a x³ + b; f⁻¹(y0) is the whole t with a t³ + b = y0.
        const y0 = Number(problem.y0);
        return Rational.of(Math.round(Math.cbrt((y0 - b) / a)));
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["composition-value", "inverse-linear"],
        ["domain", "inverse-linear", "composition-formula", "composition-value"],
        ["domain", "range", "composition-formula", "inverse-value"],
        ["domain-combined", "range", "inverse-value", "composition-formula"],
      ]),
    );
    const family = "function-properties";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const limit = calibration.coefficientRange[1];
    const nonZero = (low: number, high: number) => rng.int(low, high) || high;

    if (variant === "composition-value") {
      const a = rng.pick([2, 3, -2, -1, 4]);
      const b = rng.int(-5, 5);
      const d = rng.int(-4, 4);
      const x0 = rng.int(-3, 3);
      const order = rng.pick(["fg", "gf"] as const);
      const f = (x: number) => a * x + b;
      const g = (x: number) => x * x + d;
      const answer = order === "fg" ? f(g(x0)) : g(f(x0));
      const other = order === "fg" ? g(f(x0)) : f(g(x0));
      const symbol = order === "fg" ? "(f \\circ g)" : "(g \\circ f)";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Si $f(x) = ${linearText(a, b)}$ y $g(x) = ${polyDisplay(polyOfX([d, 0, 1])).slice(1, -1)}$, ¿cuánto vale $${symbol}(${x0})$?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(other, "composed-in-the-wrong-order"),
          numberChoice(f(x0) * g(x0), "multiplied-the-functions"),
          numberChoice(f(x0) + g(x0), "added-the-functions"),
        ],
        pool: [
          `$${symbol}(x) = ${order === "fg" ? "f(g(x))" : "g(f(x))"}$: primero se aplica ${order === "fg" ? "$g$" : "$f$"}.`,
          order === "fg" ? `$g(${x0}) = ${g(x0)}$` : `$f(${x0}) = ${f(x0)}$`,
          order === "fg" ? `$f(${g(x0)}) = ${answer}$` : `$g(${f(x0)}) = ${answer}$`,
          "El valor es:",
          math(answer),
        ],
        numericValues: [a, b, d, x0],
        problem: { variant, a, b, c: 0, d, x0, order },
        fallback: "any",
      });
    }

    if (variant === "inverse-linear") {
      const a = rng.pick([2, 3, 4, 5, -2, -3]);
      const b = nonZero(-8, 8);
      const answer = linear(Rational.of(1, a), Rational.of(-b, a));
      const prefix = "f^{-1}(x) = ";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Si $f(x) = ${linearText(a, b)}$, ¿cuál es su función inversa $f^{-1}(x)$?`)],
        correct: polyChoice(answer, "none", prefix),
        distractors: [
          polyChoice(linear(Rational.of(1, a), Rational.of(b, a)), "sign-error", prefix),
          polyChoice(
            linear(Rational.of(1, a), Rational.of(-b)),
            "divided-only-the-variable",
            prefix,
          ),
          polyChoice(linear(Rational.of(-a), Rational.of(b)), "negated-the-slope", prefix),
          textChoice(
            "reciprocal",
            "confused-inverse-with-reciprocal",
            `$f^{-1}(x) = \\dfrac{1}{${linearText(a, b)}}$`,
          ),
        ],
        pool: [
          `Escribe $y = ${linearText(a, b)}$.`,
          `Despeja $x$: $x = \\dfrac{y ${b < 0 ? "+" : "-"} ${Math.abs(b)}}{${a}}$.`,
          "Intercambia los nombres de $x$ y $y$.",
          "La inversa es:",
          `$${prefix}${polyDisplay(answer).slice(1, -1)}$`,
        ],
        numericValues: [a, b],
        problem: { variant, a, b, c: 0, d: 0 },
        fallback: "none",
      });
    }

    if (variant === "composition-formula") {
      const b = rng.int(-6, 6);
      const c = rng.pick([2, 3, -2, -1]);
      const d = nonZero(-4, 4);
      const answer = polyOfX([d * d + b, 2 * c * d, c * c]);
      const prefix = "f(g(x)) = ";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Si $f(x) = ${polyDisplay(polyOfX([b, 0, 1])).slice(1, -1)}$ y $g(x) = ${linearText(c, d)}$, ¿cuál es $f(g(x))$?`,
          ),
        ],
        correct: polyChoice(answer, "none", prefix),
        distractors: [
          polyChoice(polyOfX([c * b + d, 0, c]), "composed-in-the-wrong-order", prefix),
          polyChoice(polyOfX([d * d + b, 0, c * c]), "dropped-the-cross-term", prefix),
          polyChoice(polyOfX([b * d, b * c, d, c]), "multiplied-the-functions", prefix),
          polyChoice(polyOfX([d + b, c, 1]), "added-the-functions", prefix),
        ],
        pool: [
          "Reemplaza $x$ por $g(x)$ dentro de $f$.",
          `$f(g(x)) = (${linearText(c, d)})^2 ${b < 0 ? "-" : "+"} ${Math.abs(b)}$`,
          `$(${linearText(c, d)})^2 = ${polyDisplay(polyOfX([d * d, 2 * c * d, c * c])).slice(1, -1)}$`,
          "Suma los términos semejantes.",
          "La composición es:",
          `$${prefix}${polyDisplay(answer).slice(1, -1)}$`,
        ],
        numericValues: [b, c, d],
        problem: { variant, a: 0, b, c, d },
        fallback: "none",
      });
    }

    if (variant === "domain" || variant === "domain-combined") {
      const form: DomainForm =
        variant === "domain-combined"
          ? "root-denominator"
          : rng.pick(["root-right", "root-left", "reciprocal"] as const);
      const a = rng.int(-6, 6);
      const b = a + rng.int(1, 5);
      const answer = domainOf(form, a, b);
      const all = [span(null, null)];
      const distractors: OptionCandidate[] =
        form === "root-right"
          ? [
              intervalChoice([span(a, null)], "excluded-the-zero-of-the-root"),
              intervalChoice([span(null, a, false, true)], "reversed-the-direction"),
              intervalChoice([span(-a, null, true)], "sign-error"),
              intervalChoice(all, "assumed-all-reals"),
            ]
          : form === "root-left"
            ? [
                intervalChoice([span(a, null, true)], "reversed-the-direction"),
                intervalChoice([span(null, a)], "excluded-the-zero-of-the-root"),
                intervalChoice([span(null, -a, false, true)], "sign-error"),
                intervalChoice(all, "assumed-all-reals"),
              ]
            : form === "reciprocal"
              ? [
                  intervalChoice([span(a, null)], "kept-one-side"),
                  intervalChoice([span(null, -a), span(-a, null)], "sign-error"),
                  intervalChoice(all, "assumed-all-reals"),
                  intervalChoice([span(a, null, true)], "treated-it-as-a-root"),
                ]
              : [
                  intervalChoice([span(a, null, true)], "forgot-the-denominator"),
                  intervalChoice(complement(span(b, b, true, true)), "forgot-the-root"),
                  intervalChoice([span(a, b), span(b, null)], "excluded-the-zero-of-the-root"),
                  intervalChoice(
                    [span(a, b, true, true), span(b, null)],
                    "included-the-zero-of-the-denominator",
                  ),
                ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`¿Cuál es el dominio de $f(x) = ${domainLatex(form, a, b)}$?`)],
        correct: intervalChoice(answer, "none"),
        distractors,
        pool: [
          form === "reciprocal"
            ? "El denominador no puede ser cero."
            : "Dentro de la raíz cuadrada no puede haber un número negativo.",
          form === "root-right"
            ? `$${linearText(1, -a)} \\ge 0$, así que $x \\ge ${a}$.`
            : form === "root-left"
              ? `$${linearText(-1, a)} \\ge 0$, así que $x \\le ${a}$.`
              : form === "reciprocal"
                ? `$${linearText(1, -a)} \\neq 0$, así que $x \\neq ${a}$.`
                : `$x \\ge ${a}$ por la raíz y $x \\neq ${b}$ por el denominador.`,
          "Escribe el conjunto en notación de intervalo.",
          "El dominio es:",
          `$${intervalLatex(answer)}$`,
        ],
        numericValues: form === "root-denominator" ? [a, b] : [a],
        problem: { variant, form, a, b, c: 0, d: 0 },
        fallback: "none",
      });
    }

    if (variant === "range") {
      const a = rng.pick([1, -1, 2, -2]);
      let h = rng.int(-4, 4);
      const k = rng.int(-6, 6);
      if (h === k) h = k === 4 ? -4 : k + 1;
      const opens = a > 0;
      const answer = [opens ? span(k, null, true) : span(null, k, false, true)];
      const coefficients = [a * h * h + k, -2 * a * h, a];
      const figure: FigureSpec = {
        kind: "function-plot",
        label: "Gráfica de la función cuadrática",
        params: {
          xMin: Math.min(-1, h - 3),
          xMax: Math.max(1, h + 3),
          yMin: opens ? Math.min(-1, k - 1) : Math.min(-1, k - 9),
          yMax: opens ? Math.max(1, k + 9) : Math.max(1, k + 1),
          curves: [{ type: "polynomial", coefficients }],
          points: [{ x: h, y: k, name: "V" }],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `¿Cuál es el rango de $f(x) = ${a === 1 ? "" : a === -1 ? "-" : a}${h === 0 ? "x" : `(${linearText(1, -h)})`}^2${constantText(k)}$?`,
          ),
          { figure },
        ],
        correct: intervalChoice(answer, "none"),
        distractors: [
          intervalChoice(
            [opens ? span(h, null, true) : span(null, h, false, true)],
            "used-the-vertex-x",
          ),
          intervalChoice(
            [opens ? span(null, k, false, true) : span(k, null, true)],
            "wrong-opening-direction",
          ),
          intervalChoice([opens ? span(k, null) : span(null, k)], "excluded-the-vertex-value"),
          intervalChoice([span(null, null)], "assumed-all-reals"),
        ],
        pool: [
          `La parábola tiene vértice $V(${h}, ${k})$.`,
          opens
            ? "Como $a > 0$, abre hacia arriba: $k$ es el valor mínimo."
            : "Como $a < 0$, abre hacia abajo: $k$ es el valor máximo.",
          "El rango son los valores de $y$ que toma la función.",
          "El rango es:",
          `$${intervalLatex(answer)}$`,
        ],
        numericValues: [a, h, k],
        problem: { variant, a, b: 0, c: k, d: 0 },
        fallback: "none",
      });
    }

    // inverse-value: f(x) = a x³ + b and f⁻¹(y0) = t.
    let [a, b, t] = [1, 1, 2];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ca = rng.pick([1, 2, -1, -2]);
      const cb = rng.int(-6, 6);
      const ct = nonZero(-3, 3);
      if (Math.abs(ca * ct ** 3 + cb) <= limit) {
        [a, b, t] = [ca, cb, ct];
        break;
      }
    }
    const y0 = a * t ** 3 + b;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `Si $f(x) = ${a === 1 ? "" : a === -1 ? "-" : a}x^3${constantText(b)}$, ¿cuánto vale $f^{-1}(${y0})$?`,
        ),
      ],
      correct: numberChoice(t, "none"),
      distractors: [
        numberChoice(Rational.of(y0 - b, a), "forgot-the-cube-root"),
        numberChoice(-t, "sign-error"),
        numberChoice(y0 === 0 ? 1 : Rational.of(1, y0), "confused-inverse-with-reciprocal"),
        numberChoice(a * y0 ** 3 + b, "evaluated-f-instead"),
      ],
      pool: [
        `$f^{-1}(${y0})$ es el $x$ tal que $f(x) = ${y0}$.`,
        `$${a === 1 ? "" : a === -1 ? "-" : a}x^3${constantText(b)} = ${y0}$`,
        `$x^3 = ${math(Rational.of(y0 - b, a)).slice(1, -1)}$`,
        `$x = \\sqrt[3]{${math(Rational.of(y0 - b, a)).slice(1, -1)}}$`,
        "El valor es:",
        math(t),
      ],
      numericValues: [a, b, y0],
      problem: { variant, a, b, c: 0, d: 0, y0 },
      fallback: "any",
    });
  },
};
