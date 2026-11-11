import { Rational } from "../math/rational.js";
import { distinctInts, finishDraft, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "even" | "odd" | "multiple-of" | "nth-multiple" | "divisor-count";

function divisorCount(value: number): number {
  let count = 0;
  for (let divisor = 1; divisor <= value; divisor += 1) if (value % divisor === 0) count += 1;
  return count;
}

/** Parity, multiples and divisors of naturals: the entry to divisibility (DBA 4-5, EBC 4-5). */
export const multiples: Family = {
  id: "multiples",
  solve(problem: Record<string, unknown>): Rational {
    const variant = problem.variant as Variant;
    const base = Number(problem.base);
    if (variant === "nth-multiple") return Rational.of(base * Number(problem.n));
    if (variant === "divisor-count") return Rational.of(divisorCount(base));
    const numbers = (problem.numbers as unknown[]).map(Number);
    const match = numbers.filter((value) =>
      variant === "even"
        ? value % 2 === 0
        : variant === "odd"
          ? value % 2 === 1
          : value % base === 0,
    );
    return Rational.of(match.length === 1 ? (match[0] ?? 0) : 0);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    // Works on the positive half of the level range; a basic-math range like [-9, 9] gives 1..9.
    const high = Math.max(9, Math.floor(calibration.coefficientRange[1]));
    const variants = tier<Variant>(index, [
      ["even", "odd", "nth-multiple"],
      ["even", "odd", "multiple-of", "nth-multiple"],
      ["multiple-of", "nth-multiple", "divisor-count"],
      ["multiple-of", "divisor-count", "nth-multiple"],
    ]);
    const variant = rng.pick(variants);

    if (variant === "nth-multiple") {
      const base = rng.int(2, Math.min(high, 12));
      const n = rng.int(2, Math.min(high, 10));
      const answer = base * n;
      return finishDraft({
        family: "multiples",
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `¿Cuál es el múltiplo número $${n}$ de $${base}$, sin contar el cero?`,
            "",
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(base * (n - 1), "counted-zero-as-a-multiple"),
          numberChoice(base + n, "added-instead"),
          numberChoice(base * (n + 1), "off-by-one-multiple"),
        ],
        pool: [
          `Los múltiplos de $${base}$ se obtienen multiplicando $${base}$ por $1, 2, 3, \\dots$`,
          `Los primeros son: $${[1, 2, 3].map((k) => base * k).join(", ")}, \\dots$`,
          `El múltiplo número $${n}$ es $${base} \\times ${n}$.`,
          `$${base} \\times ${n} = ${answer}$`,
          "El múltiplo es:",
          math(answer),
        ],
        numericValues: [base, n],
        problem: { variant, base, n },
      });
    }

    if (variant === "divisor-count") {
      const base = rng.int(6, Math.min(high, 60));
      const answer = divisorCount(base);
      return finishDraft({
        family: "multiples",
        level,
        rng,
        calibration,
        stem: [prompt(rng, prompts, `¿Cuántos divisores tiene el número $${base}$?`, "")],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Math.max(1, answer - 2), "forgot-one-and-itself"),
          numberChoice(Math.max(1, answer - 1), "forgot-one-divisor"),
          numberChoice(Math.floor(base / 2), "halved-the-number"),
        ],
        pool: [
          "Un divisor divide al número sin dejar residuo.",
          `Prueba con $1, 2, 3, \\dots$ hasta $${base}$.`,
          `Divisores de $${base}$: $${Array.from({ length: base }, (_, k) => k + 1)
            .filter((d) => base % d === 0)
            .join(", ")}$`,
          "No olvides el $1$ y el mismo número.",
          "La cantidad de divisores es:",
          math(answer),
        ],
        numericValues: [base],
        problem: { variant, base },
      });
    }

    const base = variant === "multiple-of" ? rng.int(3, Math.min(9, high)) : 2;
    const ceiling = Math.max(base * 10, Math.min(high * 2, 99));
    const wantRemainder = variant === "odd" ? 1 : 0;
    const fits = (value: number) =>
      variant === "multiple-of" ? value % base === 0 : value % 2 === wantRemainder;
    let answer = rng.int(base, ceiling);
    while (!fits(answer)) answer += 1;
    const misses: Array<{ value: number; error: string }> = [];
    if (variant === "multiple-of") {
      const half = [2, 3].find((factor) => base % factor === 0 && factor !== base);
      if (half !== undefined) misses.push({ value: answer + half, error: "shares-a-factor-only" });
      misses.push({ value: answer + 1, error: "off-by-one" });
      misses.push({ value: base * 10 + 1, error: "looked-at-the-last-digit" });
      if (base > 3) misses.push({ value: base - 1, error: "confused-divisor-and-multiple" });
    }
    const pool = distinctInts(rng, 12, Math.max(1, base - 1), ceiling, new Set([answer])).filter(
      (value) => !fits(value),
    );
    for (const value of pool)
      misses.push({
        value,
        error: variant === "multiple-of" ? "not-a-multiple" : "confused-even-and-odd",
      });
    const chosen = [
      ...new Map(
        misses
          .filter((entry) => !fits(entry.value) && entry.value > 0)
          .map((entry) => [entry.value, entry]),
      ).values(),
    ].slice(0, 3);
    const numbers = rng.shuffle([answer, ...chosen.map((entry) => entry.value)]);
    const ask =
      variant === "even"
        ? "¿Cuál de estos números es par?"
        : variant === "odd"
          ? "¿Cuál de estos números es impar?"
          : `¿Cuál de estos números es múltiplo de $${base}$?`;
    return finishDraft({
      family: "multiples",
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, ask, "")],
      correct: numberChoice(answer, "none"),
      distractors: chosen.map((entry) => numberChoice(entry.value, entry.error)),
      pool: [
        variant === "multiple-of"
          ? `Un múltiplo de $${base}$ se divide entre $${base}$ sin residuo.`
          : "Un número par termina en $0, 2, 4, 6$ u $8$.",
        "Revisa cada opción.",
        variant === "multiple-of"
          ? `$${answer} \\div ${base} = ${answer / base}$, sin residuo.`
          : `$${answer}$ termina en $${answer % 10}$.`,
        "El número que cumple es:",
        math(answer),
      ],
      numericValues: variant === "multiple-of" ? [base] : [],
      problem: { variant, base, numbers },
      fallback: "none",
    });
  },
};
