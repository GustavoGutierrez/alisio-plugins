import type { FigureSpec } from "../figures/index.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { solutionSet } from "./absolute-value.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { plotWindow } from "./rate-limits.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "power-rule"
  | "slope-at-point"
  | "tangent-line"
  | "general-power"
  | "critical-points"
  | "chain-rule"
  | "trig-exp";

/** One term `c · x^e` with a rational exponent (`x^{-1}` is `1/x`, `x^{1/2}` is `√x`). */
export interface Term {
  c: Rational;
  e: Rational;
}

const term = (c: Rational | number, e: Rational | number): Term => ({
  c: Rational.from(c),
  e: Rational.from(e),
});

/** Terms merged by exponent, zeros dropped, highest exponent first: the canonical order. */
export function normalize(terms: readonly Term[]): Term[] {
  const byExponent = new Map<string, Term>();
  for (const entry of terms) {
    const key = entry.e.toString();
    const previous = byExponent.get(key);
    byExponent.set(key, previous === undefined ? entry : term(previous.c.add(entry.c), entry.e));
  }
  return [...byExponent.values()]
    .filter((entry) => !entry.c.isZero())
    .sort((left, right) => right.e.compare(left.e));
}

/** The power rule on every term: `(c x^e)' = c e x^(e - 1)`. */
export const derive = (terms: readonly Term[]): Term[] =>
  normalize(terms.map((entry) => term(entry.c.mul(entry.e), entry.e.sub(Rational.one))));

/** Canonical text, e.g. `6x^2+-1x^-2+3x^0`; `0` for the zero function. */
export function termsText(terms: readonly Term[]): string {
  const list = normalize(terms);
  return list.length === 0 ? "0" : list.map((entry) => `${entry.c}x^${entry.e}`).join("+");
}

export const evaluateTerms = (terms: readonly Term[], x: number): number =>
  terms.reduce((total, entry) => total + entry.c.toNumber() * x ** entry.e.toNumber(), 0);

/** `x^e` in LaTeX as a numerator piece and a denominator piece. */
function powerParts(e: Rational): { top: string; bottom: string } {
  const magnitude = e.abs();
  const power = (value: Rational): string => {
    if (value.isZero()) return "";
    if (value.isOne()) return "x";
    if (value.isInteger()) return `x^{${value}}`;
    if (value.equals(Rational.of(1, 2))) return "\\sqrt{x}";
    if (value.equals(Rational.of(3, 2))) return "x\\sqrt{x}";
    return `x^{${latexRational(value)}}`;
  };
  return e.sign() < 0
    ? { top: "", bottom: power(magnitude) }
    : { top: power(magnitude), bottom: "" };
}

/** The terms as LaTeX: `6x^{2} - \dfrac{1}{x^{2}} + 3`. */
export function termsLatex(terms: readonly Term[]): string {
  const list = normalize(terms);
  if (list.length === 0) return "0";
  return list
    .map((entry, position) => {
      const negative = entry.c.sign() < 0;
      const size = entry.c.abs();
      const { top, bottom } = powerParts(entry.e);
      let body: string;
      if (bottom !== "") {
        body = `\\dfrac{${size.n}}{${size.d === 1n ? "" : size.d}${bottom}}`;
      } else if (top === "") {
        body = latexRational(size);
      } else {
        body = `${size.isOne() ? "" : latexRational(size)}${top}`;
      }
      const sign = negative ? "-" : "+";
      return position === 0 ? `${negative ? "-" : ""}${body}` : ` ${sign} ${body}`;
    })
    .join("");
}

const termsChoice = (terms: readonly Term[], error: string, prefix = ""): OptionCandidate => ({
  value: termsText(terms),
  display: `$${prefix}${termsLatex(terms)}$`,
  error,
});

/** A polynomial (ascending integer coefficients) as terms. */
const polyTerms = (coefficients: readonly number[]): Term[] =>
  coefficients.map((coefficient, power) => term(coefficient, power));

/** `n·a·(ax + b)^(n-1)` as canonical text and LaTeX. */
function chainChoice(
  coefficient: number,
  a: number,
  b: number,
  power: number,
  error: string,
): OptionCandidate {
  const inner = `${a === 1 ? "" : a === -1 ? "-" : a}x ${b < 0 ? "-" : "+"} ${Math.abs(b)}`;
  return textChoice(
    `chain(${coefficient},${a},${b},${power})`,
    error,
    `$${coefficient === 1 ? "" : coefficient === -1 ? "-" : coefficient}(${inner})${power === 1 ? "" : `^{${power}}`}$`,
  );
}

/** `A cos x + B sin x + C eˣ` as canonical text and LaTeX. */
function trigChoice(cos: number, sin: number, exp: number, error: string): OptionCandidate {
  const parts: string[] = [];
  const add = (value: number, name: string) => {
    if (value === 0) return;
    const size = Math.abs(value) === 1 ? "" : String(Math.abs(value));
    const sign = value < 0 ? "-" : parts.length === 0 ? "" : "+";
    parts.push(`${parts.length === 0 ? sign : ` ${sign} `}${size}${name}`);
  };
  add(cos, "\\cos x");
  add(sin, "\\operatorname{sen} x");
  add(exp, "e^{x}");
  return textChoice(`trig(${cos},${sin},${exp})`, error, `$${parts.join("") || "0"}$`);
}

/** Derivatives: power rule, slopes, tangents, critical points, chain rule, sin/cos/eˣ (DBA 11). */
export const derivatives: Family = {
  id: "derivatives",
  solve(problem: Record<string, unknown>): Rational | string {
    const terms = ((problem.terms as unknown[]) ?? []).map((entry) => {
      const [c, e] = String(entry).split("|");
      return term(Rational.parse(c ?? "0"), Rational.parse(e ?? "0"));
    });
    const x0 = Number(problem.x0);
    switch (problem.variant as Variant) {
      case "power-rule":
      case "general-power":
        return termsText(derive(terms));
      case "slope-at-point":
        return Rational.of(Math.round(evaluateTerms(derive(terms), x0)));
      case "tangent-line": {
        // y = f'(x0)(x - x0) + f(x0), written as m x + b.
        const slope = Math.round(evaluateTerms(derive(terms), x0));
        const value = Math.round(evaluateTerms(terms, x0));
        return termsText([term(slope, 1), term(value - slope * x0, 0)]);
      }
      case "critical-points": {
        // f'(x) = 3x² + 2bx + c with whole roots: x = (-b ± √(b² - 3c)) / 3.
        const derivative = derive(terms);
        const roots: number[] = [];
        for (let x = -20; x <= 20; x += 1) {
          if (Math.abs(evaluateTerms(derivative, x)) < 1e-9) roots.push(x);
        }
        return solutionSet(roots);
      }
      case "chain-rule": {
        const a = Number(problem.a);
        const b = Number(problem.b);
        const n = Number(problem.n);
        return `chain(${n * a},${a},${b},${n - 1})`;
      }
      default:
        return `trig(${Number(problem.sin)},${-Number(problem.cos)},${Number(problem.exp)})`;
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["power-rule", "slope-at-point"],
        ["power-rule", "slope-at-point", "tangent-line"],
        ["general-power", "critical-points", "tangent-line", "slope-at-point"],
        ["chain-rule", "trig-exp", "general-power", "critical-points"],
      ]),
    );
    const family = "derivatives";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const stored = (terms: readonly Term[]) => terms.map((entry) => `${entry.c}|${entry.e}`);
    const nonZero = (low: number, high: number) => rng.int(low, high) || high;

    if (variant === "power-rule" || variant === "slope-at-point" || variant === "tangent-line") {
      const degree = variant === "tangent-line" ? 2 : index === 0 ? rng.int(2, 3) : 3;
      const coefficients = Array.from({ length: degree + 1 }, (_, power) =>
        power === degree ? nonZero(-4, 5) : rng.int(-6, 6),
      );
      if (coefficients[1] === 0) coefficients[1] = rng.pick([2, -3]);
      const terms = polyTerms(coefficients);
      const derivative = derive(terms);
      const f = `f(x) = ${termsLatex(terms)}`;
      const numericValues = coefficients.filter((value) => value !== 0);
      if (variant === "power-rule") {
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [ask(`Si $${f}$, ¿cuál es $f'(x)$?`)],
          correct: termsChoice(derivative, "none"),
          distractors: [
            termsChoice(
              terms.map((entry) => term(entry.c.mul(entry.e), entry.e)),
              "kept-the-exponent",
            ),
            termsChoice(
              terms
                .map((entry) => term(entry.c, entry.e.sub(Rational.one)))
                .filter((entry) => !entry.e.equals(Rational.one.neg())),
              "forgot-to-multiply-by-the-exponent",
            ),
            termsChoice([...derivative, term(coefficients[0] || 1, 0)], "kept-the-constant"),
            termsChoice(
              derivative.map((entry) => term(entry.c.neg(), entry.e)),
              "sign-error",
            ),
          ],
          pool: [
            "Regla de la potencia: $(c\\,x^n)' = c\\,n\\,x^{n-1}$.",
            "La derivada de una constante es $0$.",
            "Deriva término a término.",
            `$f'(x) = ${termsLatex(derivative)}$`,
            "La derivada es:",
            `$${termsLatex(derivative)}$`,
          ],
          numericValues,
          problem: { variant, terms: stored(terms), x0: 0 },
          fallback: "none",
        });
      }
      // A tangent point with a non-zero slope, so the line is not mistaken for a constant.
      let x0 = rng.int(-3, 3) || 1;
      for (let step = 0; step < 6 && Math.round(evaluateTerms(derivative, x0)) === 0; step += 1) {
        x0 = x0 >= 3 ? -3 : x0 + 1;
      }
      const slope = Math.round(evaluateTerms(derivative, x0));
      const value = Math.round(evaluateTerms(terms, x0));
      if (variant === "slope-at-point") {
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [ask(`Si $${f}$, ¿cuál es la pendiente de la recta tangente en $x = ${x0}$?`)],
          correct: numberChoice(slope, "none"),
          distractors: [
            numberChoice(value, "gave-the-function-value"),
            numberChoice(Math.round(evaluateTerms(derivative, -x0)), "sign-error"),
            numberChoice(
              Math.round(
                evaluateTerms(
                  terms.map((entry) => term(entry.c.mul(entry.e), entry.e)),
                  x0,
                ),
              ),
              "kept-the-exponent",
            ),
          ],
          pool: [
            "La pendiente de la tangente en $x_0$ es $f'(x_0)$.",
            `$f'(x) = ${termsLatex(derivative)}$`,
            `Reemplaza $x = ${x0}$ en la derivada.`,
            `$f'(${x0}) = ${slope}$`,
            "La pendiente es:",
            math(slope),
          ],
          numericValues: [...numericValues, x0],
          problem: { variant, terms: stored(terms), x0 },
          fallback: "any",
        });
      }
      const intercept = value - slope * x0;
      const line = [term(slope, 1), term(intercept, 0)];
      const tangentCurve = [intercept, slope];
      const figure: FigureSpec = {
        kind: "function-plot",
        label: "Recta tangente a la gráfica de f",
        params: {
          ...plotWindow(coefficients, Math.min(x0, x0 - 1), Math.max(x0, x0 + 1)),
          curves: [
            { type: "polynomial", coefficients },
            { type: "polynomial", coefficients: tangentCurve },
          ],
          points: [{ x: x0, y: value, name: "P" }],
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `¿Cuál es la ecuación de la recta tangente a $${f}$ en el punto $P$ con $x = ${x0}$?`,
          ),
          { figure },
        ],
        correct: termsChoice(line, "none", "y = "),
        distractors: [
          termsChoice([term(value, 1), term(intercept, 0)], "used-the-value-as-slope", "y = "),
          termsChoice([term(slope, 1), term(value, 0)], "used-the-value-as-intercept", "y = "),
          termsChoice(
            [term(slope, 1), term(value + slope * x0, 0)],
            "sign-error-in-point-slope",
            "y = ",
          ),
          termsChoice([term(slope, 1)], "dropped-the-intercept", "y = "),
          termsChoice(derivative, "gave-the-derivative", "y = "),
          termsChoice(
            [term(-slope, 1), term(value + slope * x0, 0)],
            "sign-error-in-the-slope",
            "y = ",
          ),
        ],
        pool: [
          `Punto de tangencia: $f(${x0}) = ${value}$.`,
          `Pendiente: $f'(x) = ${termsLatex(derivative)}$, así que $f'(${x0}) = ${slope}$.`,
          `Punto-pendiente: $y - (${value}) = ${slope}(x - (${x0}))$.`,
          "Despeja $y$.",
          "La recta tangente es:",
          `$y = ${termsLatex(line)}$`,
        ],
        numericValues: [...numericValues, x0],
        problem: { variant, terms: stored(terms), x0 },
        fallback: "none",
      });
    }

    if (variant === "general-power") {
      // a/x^n + b√x + c x^m: negative, fractional and whole powers in one function.
      const a = nonZero(-6, 6);
      const n = rng.int(1, 3);
      const b = rng.pick([2, 4, 6, -2, -4]);
      const c = nonZero(-5, 5);
      const m = rng.int(2, 4);
      const terms = [term(a, -n), term(b, Rational.of(1, 2)), term(c, m)];
      const derivative = derive(terms);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Si $f(x) = ${termsLatex(terms)}$ (con $x > 0$), ¿cuál es $f'(x)$?`)],
        correct: termsChoice(derivative, "none"),
        distractors: [
          termsChoice(
            terms.map((entry) => term(entry.c.mul(entry.e), entry.e.add(Rational.one))),
            "raised-the-exponent",
          ),
          termsChoice(
            derive([term(a, n), term(b, Rational.of(1, 2)), term(c, m)]),
            "treated-the-quotient-as-a-power",
          ),
          termsChoice(
            [term(-a * n, -n + 1), term(Rational.of(b, 2), Rational.of(-1, 2)), term(c * m, m - 1)],
            "lowered-the-negative-exponent-the-wrong-way",
          ),
          termsChoice(
            [term(-a * n, -n - 1), term(b * 2, Rational.of(-1, 2)), term(c * m, m - 1)],
            "inverted-the-root-coefficient",
          ),
        ],
        pool: [
          `Escribe todo como potencias: $${termsLatex(terms).replace(/\\sqrt\{x\}/g, "x^{1/2}")}$.`,
          `$\\dfrac{${Math.abs(a)}}{x^{${n}}} = ${Math.abs(a)}x^{-${n}}$ y $\\sqrt{x} = x^{1/2}$.`,
          "Aplica la regla de la potencia a cada término: $(x^r)' = r\\,x^{r-1}$.",
          `$f'(x) = ${termsLatex(derivative)}$`,
          "La derivada es:",
          `$${termsLatex(derivative)}$`,
        ],
        numericValues: [a, n, b, c, m],
        problem: { variant, terms: stored(terms), x0: 0 },
        fallback: "none",
      });
    }

    if (variant === "critical-points") {
      // f'(x) = 3(x - p)(x - q) with p + q even: f(x) = x³ - (3/2)(p + q)x² + 3pq x + d.
      const limit = calibration.coefficientRange[1];
      // Redraw until every written coefficient fits the level range; (-1, 1) always fits.
      let [p, q] = [-1, 1];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const first = rng.int(-4, 3);
        let second = rng.int(first + 1, 5);
        if ((first + second) % 2 !== 0) second += second < 5 ? 1 : -1;
        if (second === first) second = first + 2;
        if (
          Math.abs(3 * first * second) <= limit &&
          Math.abs((3 * (first + second)) / 2) <= limit
        ) {
          [p, q] = [first, second];
          break;
        }
      }
      const d = rng.int(-5, 5);
      const terms = [term(1, 3), term((-3 * (p + q)) / 2, 2), term(3 * p * q, 1), term(d, 0)];
      const derivative = derive(terms);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `¿En qué valores de $x$ tiene $f(x) = ${termsLatex(terms)}$ sus puntos críticos ($f'(x) = 0$)?`,
          ),
        ],
        correct: textChoice(solutionSet([p, q]), "none", `$x = ${p}$ y $x = ${q}$`),
        distractors: [
          textChoice(solutionSet([-p, -q]), "sign-error", `$x = ${-q}$ y $x = ${-p}$`),
          textChoice(solutionSet([(p + q) / 2]), "averaged-the-roots", `$x = ${(p + q) / 2}$`),
          textChoice(solutionSet([0, p + q]), "factored-x-out-wrongly", `$x = 0$ y $x = ${p + q}$`),
          textChoice(
            solutionSet([3 * p, 3 * q]),
            "forgot-to-divide-by-three",
            `$x = ${3 * p}$ y $x = ${3 * q}$`,
          ),
          textChoice(
            solutionSet([0, p, q]),
            "added-a-root-at-zero",
            `$x = ${Math.min(0, p)}$, $x = ${[0, p, q].sort((m, n) => m - n)[1]}$ y $x = ${Math.max(0, q)}$`,
          ),
          textChoice(
            solutionSet([p + q, p * q]),
            "gave-the-sum-and-product",
            [...new Set([p + q, p * q])]
              .sort((m, n) => m - n)
              .map((value) => `$x = ${value}$`)
              .join(" y "),
          ),
        ],
        pool: [
          "Los puntos críticos son donde $f'(x) = 0$.",
          `$f'(x) = ${termsLatex(derivative)}$`,
          `Saca factor común $3$: $3\\left(x^2 ${-(p + q) < 0 ? "-" : "+"} ${Math.abs(p + q)}x ${p * q < 0 ? "-" : "+"} ${Math.abs(p * q)}\\right) = 0$.`,
          `$(x - (${p}))(x - (${q})) = 0$`,
          "Los puntos críticos están en:",
          `$x = ${p}$ y $x = ${q}$`,
        ],
        numericValues: [3 * p * q, (3 * (p + q)) / 2, d].filter((value) => Number.isInteger(value)),
        problem: { variant, terms: stored(terms), x0: 0 },
        fallback: "none",
      });
    }

    if (variant === "chain-rule") {
      const a = rng.pick([2, 3, 4, 5, -2, -3]);
      const b = nonZero(-7, 7);
      const n = rng.int(3, 6);
      const inner = `${a === -1 ? "-" : a}x ${b < 0 ? "-" : "+"} ${Math.abs(b)}`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`Si $f(x) = (${inner})^{${n}}$, ¿cuál es $f'(x)$?`)],
        correct: chainChoice(n * a, a, b, n - 1, "none"),
        distractors: [
          chainChoice(n, a, b, n - 1, "forgot-the-inner-derivative"),
          chainChoice(n * a, a, b, n, "kept-the-exponent"),
          chainChoice(a, a, b, n - 1, "forgot-the-outer-exponent"),
          chainChoice(n * b, a, b, n - 1, "multiplied-by-the-constant-term"),
          chainChoice(n * a * a, a, b, n - 1, "squared-the-inner-derivative"),
        ],
        pool: [
          "Regla de la cadena: $\\left[g(x)^n\\right]' = n\\,g(x)^{n-1}\\,g'(x)$.",
          `Aquí $g(x) = ${inner}$ y $g'(x) = ${a}$.`,
          `$f'(x) = ${n}(${inner})^{${n - 1}} \\cdot ${a < 0 ? `(${a})` : a}$`,
          "Multiplica los coeficientes.",
          "La derivada es:",
          chainChoice(n * a, a, b, n - 1, "none").display,
        ],
        numericValues: [a, b, n],
        problem: { variant, a, b, n },
        fallback: "none",
      });
    }

    // trig-exp: f(x) = A sen x + B cos x + C eˣ → A cos x − B sen x + C eˣ.
    const sin = nonZero(-6, 6);
    const cos = nonZero(-6, 6);
    const exp = rng.int(-4, 5);
    const fParts: string[] = [];
    const push = (value: number, name: string) => {
      if (value === 0) return;
      const size = Math.abs(value) === 1 ? "" : String(Math.abs(value));
      const sign = value < 0 ? "-" : fParts.length === 0 ? "" : "+";
      fParts.push(`${fParts.length === 0 ? sign : ` ${sign} `}${size}${name}`);
    };
    push(sin, "\\operatorname{sen} x");
    push(cos, "\\cos x");
    push(exp, "e^{x}");
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(`Si $f(x) = ${fParts.join("")}$, ¿cuál es $f'(x)$?`)],
      correct: trigChoice(sin, -cos, exp, "none"),
      distractors: [
        trigChoice(sin, cos, exp, "sign-error-in-the-cosine-derivative"),
        trigChoice(-sin, cos, exp, "swapped-the-signs"),
        trigChoice(sin, -cos, 0, "differentiated-e-to-zero"),
        trigChoice(cos, sin, exp, "did-not-differentiate"),
        trigChoice(-sin, -cos, exp, "negated-the-cosine-term"),
      ],
      pool: [
        "$(\\operatorname{sen} x)' = \\cos x$",
        "$(\\cos x)' = -\\operatorname{sen} x$",
        "$(e^{x})' = e^{x}$",
        "Deriva término a término.",
        "La derivada es:",
        trigChoice(sin, -cos, exp, "none").display,
      ],
      numericValues: [sin, cos, exp].filter((value) => value !== 0),
      problem: { variant, sin, cos, exp },
      fallback: "none",
    });
  },
};
