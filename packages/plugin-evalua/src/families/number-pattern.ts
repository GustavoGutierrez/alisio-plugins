import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Rule = "add" | "subtract" | "multiply" | "alternate";

interface Pattern {
  rule: Rule;
  start: number;
  /** The step (add/subtract), the factor (multiply) or the first of two steps (alternate). */
  step: number;
  /** The second step of an alternating pattern. */
  second?: number;
  length: number;
  /** Index of the term the student finds; the last one means "the next term". */
  missing: number;
}

function terms(pattern: Pattern): number[] {
  const out = [pattern.start];
  for (let index = 1; index < pattern.length; index += 1) {
    const previous = out[index - 1] ?? 0;
    const next =
      pattern.rule === "add"
        ? previous + pattern.step
        : pattern.rule === "subtract"
          ? previous - pattern.step
          : pattern.rule === "multiply"
            ? previous * pattern.step
            : previous + (index % 2 === 1 ? pattern.step : (pattern.second ?? pattern.step));
    out.push(next);
  }
  return out;
}

function ruleText(pattern: Pattern): string {
  if (pattern.rule === "add")
    return `Cada término se obtiene sumando $${pattern.step}$ al anterior.`;
  if (pattern.rule === "subtract")
    return `Cada término se obtiene restando $${pattern.step}$ al anterior.`;
  if (pattern.rule === "multiply")
    return `Cada término se obtiene multiplicando por $${pattern.step}$ el anterior.`;
  return `Se suma $${pattern.step}$ y luego $${pattern.second ?? pattern.step}$, alternando.`;
}

/** Number sequences with a rule: find the next or a missing term (DBA 2 #8-9). */
export const numberPattern: Family = {
  id: "number-pattern",
  solve(problem: Record<string, unknown>): Rational {
    const pattern = problem as unknown as Pattern;
    return Rational.of(terms(pattern)[pattern.missing] ?? 0);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const high = levelHigh(calibration, 9999, 20);
    const rules = tier<Rule>(index, [
      ["add"],
      ["add", "subtract"],
      ["add", "subtract", "multiply"],
      ["add", "subtract", "multiply", "alternate"],
    ]);
    const rule = rng.pick(rules);
    const length = 5;
    let pattern: Pattern;
    if (rule === "multiply") {
      const factor = rng.int(2, 3);
      const start = rng.int(1, Math.max(1, Math.floor(high / factor ** (length - 1))));
      pattern = { rule, start, step: factor, length, missing: length - 1 };
    } else {
      const steps =
        index === 0 ? [1, 2, 5, 10].filter((step) => step * (length - 1) < high) : undefined;
      const maxStep = Math.max(1, Math.floor(high / (length + 1)));
      const step =
        steps === undefined
          ? rng.int(2, Math.max(2, Math.min(maxStep, index >= 2 ? 100 : 10)))
          : rng.pick(steps);
      const drawn =
        rule === "alternate" ? rng.int(1, Math.max(1, Math.min(maxStep, 20))) : undefined;
      const second = drawn === step ? step + 1 : drawn;
      const span =
        rule === "alternate"
          ? Math.ceil(((step + (second ?? 0)) * (length - 1)) / 2)
          : step * (length - 1);
      const startHigh = Math.max(1, high - span);
      const start =
        rule === "subtract" ? rng.int(span + 1, Math.max(span + 1, high)) : rng.int(1, startHigh);
      const missing = index === 0 ? length - 1 : rng.int(1, length - 1);
      pattern = { rule, start, step, ...(second === undefined ? {} : { second }), length, missing };
    }
    const values = terms(pattern);
    const answer = values[pattern.missing] ?? 0;
    const before = values[pattern.missing - 1] ?? 0;
    const shown = values.map((value, position) =>
      position === pattern.missing ? "\\_\\_" : String(value),
    );
    const difference = (values[1] ?? 0) - (values[0] ?? 0);
    const instruction = prompt(
      rng,
      prompts,
      "Completa la secuencia: {expr}",
      `$${shown.join(",\\ ")}$`,
    );
    return finishDraft({
      family: "number-pattern",
      level,
      rng,
      calibration,
      stem: [instruction],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(Math.abs(answer + (answer - before)), "skipped-a-term"),
        numberChoice(Math.max(0, before + 1), "added-one"),
        numberChoice(Math.max(0, before - (answer - before)), "reversed-the-rule"),
        numberChoice(Math.max(0, before + difference), "used-the-first-difference"),
        numberChoice(answer + 1, "off-by-one"),
      ],
      pool: [
        "Observa cómo cambia la secuencia de un término al siguiente.",
        `Diferencia entre los dos primeros: $${values[1] ?? 0} - ${values[0] ?? 0} = ${difference}$`,
        ruleText(pattern),
        `Aplica la regla al término anterior, $${before}$.`,
        "El término que falta es:",
        math(answer),
      ],
      numericValues: values.filter((_, position) => position !== pattern.missing),
      problem: { ...pattern },
    });
  },
};
