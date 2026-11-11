import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { finishDraft, levelIndex, math, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "classify" | "repeating" | "which-irrational";
type NumberSet = "N" | "Z" | "Q" | "I";

const SET_LABEL: Record<NumberSet, string> = {
  N: "Naturales ($\\mathbb{N}$)",
  Z: "Enteros ($\\mathbb{Z}$), no naturales",
  Q: "Racionales ($\\mathbb{Q}$), no enteros",
  I: "Irracionales ($\\mathbb{I}$)",
};

/** A real number shown to the student, with the smallest set it belongs to. */
interface Shown {
  latex: string;
  set: NumberSet;
  /** Canonical text for "which one is irrational" options. */
  key: string;
}

const isSquare = (n: number): boolean => Number.isInteger(Math.sqrt(n));

/** One number of the requested kind, built from small integers. */
function sample(rng: Rng, set: NumberSet, hard: boolean): Shown {
  switch (set) {
    case "N": {
      if (rng.int(0, 1) === 0) {
        const root = rng.int(2, 12);
        return { latex: `\\sqrt{${root * root}}`, set, key: `sqrt${root * root}` };
      }
      const value = rng.int(1, 40);
      return { latex: hard ? `\\dfrac{${value * 2}}{2}` : `${value}`, set, key: `n${value}` };
    }
    case "Z": {
      if (rng.int(0, 1) === 0) {
        const root = rng.int(2, 9);
        return { latex: `-\\sqrt{${root * root}}`, set, key: `-sqrt${root * root}` };
      }
      const value = -rng.int(1, 40);
      return { latex: `${value}`, set, key: `z${value}` };
    }
    case "Q": {
      const kind = rng.int(0, 2);
      if (kind === 0) {
        const d = rng.pick([3, 4, 5, 7, 8, 9]);
        let n = rng.int(1, 3 * d);
        if (n % d === 0) n += 1;
        return {
          latex: `${rng.int(0, 1) === 0 ? "-" : ""}\\dfrac{${n}}{${d}}`,
          set,
          key: `q${n}/${d}`,
        };
      }
      if (kind === 1) {
        // 0,999… is 1, so the repeated digit stops at 8.
        const digit = rng.int(1, 8);
        return { latex: `0{,}\\overline{${digit}}`, set, key: `rep${digit}` };
      }
      const tenths = rng.int(11, 99);
      return {
        latex: `${Math.floor(tenths / 10)}{,}${tenths % 10 || 5}`,
        set,
        key: `dec${tenths}`,
      };
    }
    default: {
      const kind = rng.int(0, 2);
      if (kind === 0) {
        let n = rng.int(2, 50);
        while (isSquare(n)) n += 1;
        return { latex: `\\sqrt{${n}}`, set, key: `sqrt${n}` };
      }
      if (kind === 1) {
        const k = rng.int(1, 5);
        return { latex: k === 1 ? "\\pi" : `${k}\\pi`, set, key: `pi${k}` };
      }
      const digit = rng.int(1, 9);
      // A non-repeating pattern: one more zero before each 1.
      return { latex: `${digit}{,}1010010001\\ldots`, set, key: `nr${digit}` };
    }
  }
}

/** `0.\overline{ab}` or `0.a\overline{b}` and its fraction. */
function repeating(rng: Rng, index: number): { latex: string; value: Rational; wrong: Rational[] } {
  if (index <= 1) {
    const digit = rng.int(1, 8);
    return {
      latex: `0{,}\\overline{${digit}}`,
      value: Rational.of(digit, 9),
      wrong: [Rational.of(digit, 10), Rational.of(digit, 99), Rational.of(1, digit + 1)],
    };
  }
  if (index === 2 || rng.int(0, 1) === 0) {
    let block = rng.int(10, 98);
    if (block % 11 === 0) block += 1;
    return {
      latex: `0{,}\\overline{${block}}`,
      value: Rational.of(block, 99),
      wrong: [Rational.of(block, 100), Rational.of(block, 90), Rational.of(block, 9)],
    };
  }
  const head = rng.int(1, 9);
  let tail = rng.int(1, 9);
  if (tail === head) tail = (tail % 9) + 1;
  return {
    latex: `0{,}${head}\\overline{${tail}}`,
    value: Rational.of(10 * head + tail - head, 90),
    wrong: [
      Rational.of(10 * head + tail, 99),
      Rational.of(10 * head + tail, 90),
      Rational.of(10 * head + tail, 100),
    ],
  };
}

/** Rational and irrational numbers: the smallest set of a number and repeating decimals (DBA 8 #1). */
export const numberSets: Family = {
  id: "number-sets",
  solve(problem: Record<string, unknown>): Rational | string {
    if (problem.variant === "repeating") return Rational.parse(String(problem.value));
    return String(problem.answer);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["classify"],
        ["classify", "repeating"],
        ["classify", "repeating", "which-irrational"],
        ["repeating", "which-irrational", "classify"],
      ]),
    );
    const family = "number-sets";
    const hard = index >= 2;

    if (variant === "classify") {
      const set = rng.pick<NumberSet>(["N", "Z", "Q", "I"]);
      const shown = sample(rng, set, hard);
      const sets: NumberSet[] = ["N", "Z", "Q", "I"];
      const errorFor = (other: NumberSet): string =>
        other === "I"
          ? "called-a-rational-irrational"
          : set === "I"
            ? "called-an-irrational-rational"
            : "picked-a-larger-set";
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            "¿Cuál es el conjunto más pequeño al que pertenece el número {expr}?",
            `$${shown.latex}$`,
          ),
        ],
        correct: textChoice(set, "none", SET_LABEL[set]),
        distractors: sets
          .filter((other) => other !== set)
          .map((other) => textChoice(other, errorFor(other), SET_LABEL[other])),
        pool: [
          "$\\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q}$; los irracionales no se escriben como fracción.",
          set === "I"
            ? "Su expresión decimal es infinita y no periódica."
            : set === "Q"
              ? "Se escribe como fracción, pero no es un número entero."
              : `Simplifica: $${shown.latex} = ${shown.key.replace(/^(-?)sqrt(\d+)$/, (_, sign, n) => `${sign}${Math.sqrt(Number(n))}`).replace(/^[nz]/, "")}$`,
          "El conjunto más pequeño es:",
          SET_LABEL[set],
        ],
        numericValues: [],
        problem: { variant, answer: set },
        fallback: "none",
      });
    }

    if (variant === "repeating") {
      const { latex, value, wrong } = repeating(rng, index);
      const distractors: OptionCandidate[] = [
        numberChoice(wrong[0] ?? value.add(Rational.one), "treated-it-as-terminating"),
        numberChoice(wrong[1] ?? value.add(Rational.one), "used-the-wrong-nines"),
        numberChoice(wrong[2] ?? value.add(Rational.one), "misplaced-the-period"),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            "Escribe como fracción irreducible el decimal periódico {expr}",
            `$${latex}$`,
          ),
        ],
        correct: numberChoice(value, "none"),
        distractors,
        pool: [
          "Un decimal periódico es un número racional.",
          "El periodo va sobre tantos nueves como cifras tiene; un anteperiodo añade ceros.",
          `$${latex} = ${latexRational(value)}$`,
          "Simplifica la fracción.",
          "La fracción es:",
          math(value),
        ],
        numericValues: [],
        problem: { variant, value: value.toString() },
        fallback: "any",
      });
    }

    // Exactly one irrational among four numbers.
    const irrational = sample(rng, "I", hard);
    const others: Shown[] = [];
    const used = new Set([irrational.key]);
    for (const set of rng.shuffle<NumberSet>(["N", "Z", "Q", "Q"])) {
      for (let guard = 0; guard < 10; guard += 1) {
        const candidate = sample(rng, set, hard);
        if (!used.has(candidate.key)) {
          used.add(candidate.key);
          others.push(candidate);
          break;
        }
      }
      if (others.length === 3) break;
    }
    const choice = (entry: Shown, error: string) =>
      textChoice(entry.key, error, `$${entry.latex}$`);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [prompt(rng, prompts, "¿Cuál de estos números es irracional?", "")],
      correct: choice(irrational, "none"),
      distractors: others.map((entry) =>
        choice(
          entry,
          entry.latex.includes("sqrt")
            ? "assumed-every-root-is-irrational"
            : entry.latex.includes("overline")
              ? "called-a-repeating-decimal-irrational"
              : "picked-a-rational",
        ),
      ),
      pool: [
        "Un número es irracional si no puede escribirse como fracción de enteros.",
        "Las raíces de cuadrados perfectos y los decimales periódicos son racionales.",
        `$${irrational.latex}$ tiene infinitas cifras decimales sin periodo.`,
        "El número irracional es:",
        `$${irrational.latex}$`,
      ],
      numericValues: [],
      problem: { variant, answer: irrational.key },
      fallback: "none",
    });
  },
};
