import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt, rangeValue } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "arithmetic-next"
  | "geometric-next"
  | "arithmetic-nth"
  | "difference"
  | "arithmetic-rule"
  | "geometric-nth"
  | "classify"
  | "arithmetic-sum";

/** The general term `d·n + c` as canonical text (`3n+2`, `-n-4`, `5n`). */
export function nTermText(d: number, c: number): string {
  const slope = d === 1 ? "n" : d === -1 ? "-n" : `${d}n`;
  if (c === 0) return slope;
  return `${slope}${c < 0 ? "-" : "+"}${Math.abs(c)}`;
}

const nTermMath = (d: number, c: number): string =>
  `$a_n = ${nTermText(d, c)
    .replace(/([+-])/g, " $1 ")
    .replace(/^ - /, "-")}$`;

const termAt = (a1: Rational, step: Rational, n: number, geometric: boolean): Rational =>
  geometric ? a1.mul(step.pow(n - 1)) : a1.add(step.mul(Rational.of(n - 1)));

const listMath = (terms: readonly Rational[]): string =>
  `$${terms.map((term) => latexRational(term)).join(",\\ ")},\\ \\ldots$`;

/** Arithmetic and geometric sequences: next and n-th terms, the rule, and sums (DBA 9 #3). */
export const sequences: Family = {
  id: "sequences",
  solve(problem: Record<string, unknown>): Rational | string {
    const a1 = Rational.parse(String(problem.a1));
    const step = Rational.parse(String(problem.step));
    const n = Number(problem.n);
    switch (problem.variant as Variant) {
      case "arithmetic-next":
      case "arithmetic-nth":
        return termAt(a1, step, n, false);
      case "geometric-next":
      case "geometric-nth":
        return termAt(a1, step, n, true);
      case "difference":
        return step;
      case "arithmetic-rule":
        return nTermText(Number(step.n), Number(a1.sub(step).n));
      case "classify":
        return String(problem.kind);
      default: {
        const last = termAt(a1, step, n, false);
        return a1.add(last).mul(Rational.of(n, 2));
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["arithmetic-next", "geometric-next"],
        ["arithmetic-next", "arithmetic-nth", "geometric-next", "difference"],
        ["arithmetic-nth", "arithmetic-rule", "geometric-nth", "classify"],
        ["arithmetic-sum", "arithmetic-rule", "geometric-nth", "classify"],
      ]),
    );
    const family = "sequences";
    const range = calibration.coefficientRange;
    const small: [number, number] = [Math.max(range[0], -9), Math.min(range[1], 9)];
    const ask = (text: string, expr: string) => prompt(rng, prompts, text, expr);

    if (variant.startsWith("geometric") || (variant === "classify" && rng.int(0, 1) === 0)) {
      const ratios = index === 0 ? [2, 3] : index === 1 ? [2, 3, -2] : [2, 3, -2, -3];
      const ratio = Rational.of(rng.pick(ratios));
      const a1 = Rational.of(rangeValue(rng, [Math.max(-5, small[0]), Math.min(5, small[1])]));
      const terms = [1, 2, 3, 4].map((n) => termAt(a1, ratio, n, true));
      if (variant === "classify") return classify(true, terms, ratio);
      const nth = variant === "geometric-nth";
      const n = nth ? rng.int(5, index >= 3 ? 8 : 6) : 5;
      const answer = termAt(a1, ratio, n, true);
      const last = terms[3] ?? Rational.zero;
      const previous = terms[2] ?? Rational.zero;
      const distractors: OptionCandidate[] = nth
        ? [
            numberChoice(termAt(a1, ratio, n + 1, true), "used-n-instead-of-n-minus-1"),
            numberChoice(a1.mul(ratio).mul(Rational.of(n - 1)), "multiplied-instead-of-powering"),
            numberChoice(termAt(a1, ratio, n - 1, true), "stopped-one-term-early"),
          ]
        : [
            numberChoice(last.add(last.sub(previous)), "treated-it-as-arithmetic"),
            numberChoice(last.add(ratio), "added-the-ratio"),
            numberChoice(last.mul(ratio).mul(ratio), "skipped-a-term"),
          ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            nth
              ? `En la sucesión geométrica {expr}, ¿cuál es el término $a_{${n}}$?`
              : "¿Cuál es el siguiente término de la sucesión {expr}?",
            listMath(terms),
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors,
        pool: [
          "En una sucesión geométrica cada término se multiplica por la razón $r$.",
          `$r = ${latexRational(terms[1] ?? Rational.one)} \\div ${latexRational(a1).replace(/^-.*/, (text) => `(${text})`)} = ${latexRational(ratio)}$`,
          nth ? `$a_n = a_1 \\cdot r^{n-1}$` : `El término siguiente es $a_5 = a_4 \\cdot r$.`,
          nth
            ? `$a_{${n}} = ${latexRational(a1)} \\cdot (${latexRational(ratio)})^{${n - 1}}$`
            : `$a_5 = ${latexRational(last)} \\cdot (${latexRational(ratio)})$`,
          "El término es:",
          math(answer),
        ],
        numericValues: [Number(a1.n), Number(ratio.n)],
        problem: { variant, a1: a1.toString(), step: ratio.toString(), n },
        fallback: "any",
      });
    }

    const a1 = rangeValue(rng, small, { allowZero: true });
    const d = rangeValue(rng, [Math.max(-6, small[0]), Math.min(6, small[1])], { minMagnitude: 2 });
    const first = Rational.of(a1);
    const step = Rational.of(d);
    const terms = [1, 2, 3, 4].map((n) => termAt(first, step, n, false));
    if (variant === "classify") return classify(false, terms, step);

    if (variant === "arithmetic-rule") {
      const c = a1 - d;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("¿Cuál es el término general de la sucesión {expr}?", listMath(terms))],
        correct: textChoice(nTermText(d, c), "none", nTermMath(d, c)),
        distractors: [
          textChoice(nTermText(d, a1), "used-the-first-term-as-constant", nTermMath(d, a1)),
          textChoice(
            nTermText(a1 === 0 ? 1 : a1, d),
            "swapped-difference-and-first-term",
            nTermMath(a1 === 0 ? 1 : a1, d),
          ),
          textChoice(nTermText(d, c + 2 * d), "shifted-the-index", nTermMath(d, c + 2 * d)),
          textChoice(nTermText(-d, c), "flipped-the-difference", nTermMath(-d, c)),
        ],
        pool: [
          `La diferencia común es $d = ${d}$.`,
          "En una sucesión aritmética $a_n = a_1 + (n - 1) d$.",
          `$a_n = ${a1} + (n - 1)(${d})$`,
          `$a_n = ${d}n ${c < 0 ? "-" : "+"} ${Math.abs(c)}$`,
          "El término general es:",
          nTermMath(d, c),
        ],
        numericValues: [a1, d],
        problem: { variant, a1: String(a1), step: String(d), n: 0 },
        fallback: "none",
      });
    }

    if (variant === "difference") {
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask("¿Cuál es la diferencia común de la sucesión aritmética {expr}?", listMath(terms)),
        ],
        correct: numberChoice(d, "none"),
        distractors: [
          numberChoice(-d, "subtracted-in-the-wrong-order"),
          numberChoice(a1 + d === d ? 2 * d : a1 + d, "gave-a-term"),
          numberChoice(2 * d, "skipped-a-term"),
        ],
        pool: [
          "La diferencia común es lo que se suma para pasar de un término al siguiente.",
          `$d = a_2 - a_1 = ${a1 + d} - ${a1 < 0 ? `(${a1})` : a1}$`,
          `Comprueba: $${a1 + 2 * d} - ${a1 + d < 0 ? `(${a1 + d})` : a1 + d} = ${d}$`,
          "La diferencia es:",
          math(d),
        ],
        numericValues: [a1, d],
        problem: { variant, a1: String(a1), step: String(d), n: 0 },
        fallback: "any",
      });
    }

    if (variant === "arithmetic-sum") {
      const n = rng.int(6, 20);
      const last = a1 + (n - 1) * d;
      const answer = Rational.of(n * (a1 + last), 2);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Calcula la suma de los primeros $${n}$ términos de la sucesión aritmética {expr}`,
            listMath(terms),
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(n * (a1 + last), "forgot-to-halve"),
          numberChoice(n * last, "multiplied-the-last-term"),
          numberChoice(Rational.of(n * (a1 + last + d), 2), "used-the-next-term"),
        ],
        pool: [
          "La suma de una sucesión aritmética es $S_n = \\dfrac{n (a_1 + a_n)}{2}$.",
          `$a_{${n}} = ${a1} + (${n} - 1)(${d}) = ${last}$`,
          `$S_{${n}} = \\dfrac{${n} \\cdot (${a1} + ${last < 0 ? `(${last})` : last})}{2}$`,
          `$S_{${n}} = \\dfrac{${n * (a1 + last)}}{2}$`,
          "La suma es:",
          math(answer),
        ],
        numericValues: [a1, d, n],
        problem: { variant, a1: String(a1), step: String(d), n },
        fallback: "any",
      });
    }

    const nth = variant === "arithmetic-nth";
    const n = nth ? rng.int(8, Math.max(10, Math.min(30, range[1]))) : 5;
    const answer = a1 + (n - 1) * d;
    const last = a1 + 3 * d;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          nth
            ? `En la sucesión aritmética {expr}, ¿cuál es el término $a_{${n}}$?`
            : "¿Cuál es el siguiente término de la sucesión {expr}?",
          listMath(terms),
        ),
      ],
      correct: numberChoice(answer, "none"),
      distractors: nth
        ? [
            numberChoice(a1 + n * d, "used-n-instead-of-n-minus-1"),
            numberChoice(n * d, "forgot-the-first-term"),
            numberChoice(a1 * n + d, "multiplied-the-first-term"),
          ]
        : [
            numberChoice(last - d, "subtracted-the-difference"),
            numberChoice(last + 2 * d, "skipped-a-term"),
            numberChoice(last + a1 === answer ? last * 2 : last + a1, "added-the-first-term"),
          ],
      pool: [
        `La diferencia común es $d = ${d}$.`,
        nth
          ? "En una sucesión aritmética $a_n = a_1 + (n - 1) d$."
          : "Cada término es el anterior más $d$.",
        nth ? `$a_{${n}} = ${a1} + (${n} - 1)(${d})$` : `$a_5 = ${last} + (${d})$`,
        nth
          ? `$a_{${n}} = ${a1} + ${(n - 1) * d < 0 ? `(${(n - 1) * d})` : (n - 1) * d}$`
          : `$a_5 = ${answer}$`,
        "El término es:",
        math(answer),
      ],
      numericValues: nth ? [a1, d, n] : [a1, d],
      problem: { variant, a1: String(a1), step: String(d), n },
      fallback: "any",
    });

    function classify(geometric: boolean, shown: readonly Rational[], value: Rational): ItemDraft {
      const label = (kind: "a" | "g", amount: Rational) =>
        kind === "a"
          ? `Aritmética de diferencia $${latexRational(amount)}$`
          : `Geométrica de razón $${latexRational(amount)}$`;
      const choice = (kind: "a" | "g", amount: Rational, error: string) =>
        textChoice(`${kind}:${amount.toString()}`, error, label(kind, amount));
      const own = geometric ? "g" : "a";
      const other = geometric ? "a" : "g";
      const crossValue = (shown[1] ?? Rational.zero).sub(shown[0] ?? Rational.zero);
      const kind = `${own}:${value.toString()}`;
      const candidates: OptionCandidate[] = [
        choice(own, value.neg(), "flipped-the-sign"),
        choice(other, geometric ? crossValue : value, "confused-the-type"),
        geometric
          ? choice(own, value.isZero() ? Rational.one : value.inv(), "inverted-the-ratio")
          : choice(own, value.mul(Rational.of(2)), "skipped-a-term"),
        choice(other, value.mul(Rational.of(2)), "confused-the-type"),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask("¿Qué tipo de sucesión es {expr}?", listMath(shown))],
        correct: choice(own, value, "none"),
        distractors: candidates,
        pool: [
          "Aritmética: se suma siempre lo mismo. Geométrica: se multiplica siempre por lo mismo.",
          `Diferencias: $${latexRational(crossValue)}$, $${latexRational((shown[2] ?? Rational.zero).sub(shown[1] ?? Rational.zero))}$.`,
          geometric
            ? `Cocientes: siempre $${latexRational(value)}$.`
            : `La diferencia es siempre $${latexRational(value)}$.`,
          "La sucesión es:",
          label(own, value),
        ],
        numericValues: shown.slice(0, 2).map((term) => Number(term.n)),
        problem: { variant: "classify", kind, a1: "0", step: "0", n: 0 },
        fallback: "none",
      });
    }
  },
};
