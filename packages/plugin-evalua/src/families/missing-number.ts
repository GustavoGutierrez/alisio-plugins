import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

/**
 * Forms, with `x` the unknown: `a + x = c`, `x - b = c`, `a - x = c`, `a × x = c`, `x ÷ b = c`,
 * and the balance `a + b = x + d`. The equal sign reads as "both sides are worth the same".
 */
type Form = "add" | "minuend" | "subtrahend" | "times" | "divide" | "balance";

interface Problem {
  form: Form;
  a: number;
  b: number;
  c: number;
  d?: number;
}

function unknown(problem: Problem): number {
  switch (problem.form) {
    case "add":
      return problem.c - problem.a;
    case "minuend":
      return problem.c + problem.b;
    case "subtrahend":
      return problem.a - problem.c;
    case "times":
      return problem.c / problem.a;
    case "divide":
      return problem.c * problem.b;
    default:
      return problem.a + problem.b - (problem.d ?? 0);
  }
}

const BOX = "\\square";

function equation(problem: Problem): string {
  const { a, b, c, d } = problem;
  switch (problem.form) {
    case "add":
      return `${a} + ${BOX} = ${c}`;
    case "minuend":
      return `${BOX} - ${b} = ${c}`;
    case "subtrahend":
      return `${a} - ${BOX} = ${c}`;
    case "times":
      return `${a} \\times ${BOX} = ${c}`;
    case "divide":
      return `${BOX} \\div ${b} = ${c}`;
    default:
      return `${a} + ${b} = ${BOX} + ${d ?? 0}`;
  }
}

function distractors(problem: Problem, answer: number): OptionCandidate[] {
  const { a, b, c, d } = problem;
  switch (problem.form) {
    case "add":
      return [numberChoice(c + a, "added-instead"), numberChoice(c, "copied-the-result")];
    case "minuend":
      return [
        numberChoice(Math.abs(c - b), "subtracted-instead"),
        numberChoice(c, "copied-the-result"),
      ];
    case "subtrahend":
      return [numberChoice(a + c, "added-instead"), numberChoice(c, "copied-the-result")];
    case "times":
      return [numberChoice(c - a, "subtracted-instead"), numberChoice(c * a, "multiplied-instead")];
    case "divide":
      return [numberChoice(c, "copied-the-result"), numberChoice(c + b, "added-instead")];
    default:
      return [
        numberChoice(a + b, "ignored-the-right-term"),
        numberChoice(a + b + (d ?? 0), "added-every-number"),
        numberChoice(Math.abs(answer - 2 * (d ?? 0)) || answer + 2, "moved-the-term-twice"),
      ];
  }
}

/** The equal sign as balance: find the unknown number of an equality (DBA 1 #9, 2 #8). */
export const missingNumber: Family = {
  id: "missing-number",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(unknown(problem as unknown as Problem));
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const high = levelHigh(calibration, 9999, 20);
    const forms = tier<Form>(index, [
      ["add", "minuend", "subtrahend"],
      ["add", "minuend", "subtrahend", "balance"],
      ["add", "subtrahend", "times", "divide", "balance"],
      ["minuend", "subtrahend", "times", "divide", "balance"],
    ]);
    const form = rng.pick(forms);
    const small = Math.max(2, Math.min(12, high));
    let problem: Problem;
    if (form === "times" || form === "divide") {
      const factor = rng.int(2, small);
      const other = rng.int(2, Math.max(2, Math.min(small, Math.floor(high / factor))));
      problem =
        form === "times"
          ? { form, a: factor, b: 0, c: factor * other }
          : { form, a: 0, b: factor, c: other };
    } else if (form === "balance") {
      const a = rng.int(1, Math.floor(high / 2));
      const b = rng.int(1, Math.floor(high / 2));
      const d = rng.int(1, Math.max(1, a + b - 1));
      problem = { form, a, b, c: 0, d };
    } else {
      const answer = rng.int(1, Math.max(1, high - 1));
      const other = rng.int(1, Math.max(1, high - answer));
      problem =
        form === "add"
          ? { form, a: other, b: 0, c: other + answer }
          : form === "minuend"
            ? { form, a: 0, b: other, c: Math.max(1, answer - other) }
            : { form, a: answer + other, b: 0, c: other };
    }
    if (form === "minuend") problem.c = Math.max(1, problem.c);
    const answer = unknown(problem);
    const literals = [problem.a, problem.b, problem.c, problem.d ?? 0].filter(
      (value) => value !== 0,
    );
    const instruction = prompt(
      rng,
      prompts,
      "¿Qué número va en el cuadro para que la igualdad sea verdadera? {expr}",
      `$${equation(problem)}$`,
    );
    return finishDraft({
      family: "missing-number",
      level,
      rng,
      calibration,
      stem: [instruction],
      correct: numberChoice(answer, "none"),
      distractors: distractors(problem, answer),
      pool: [
        "El signo igual indica que los dos lados valen lo mismo.",
        `Escribe la igualdad: $${equation(problem)}$`,
        "Usa la operación inversa para hallar el número del cuadro.",
        `Comprueba: $${equation(problem).replace(BOX, String(answer))}$`,
        "El número del cuadro es:",
        math(answer),
      ],
      numericValues: literals,
      problem: { ...problem },
    });
  },
};
