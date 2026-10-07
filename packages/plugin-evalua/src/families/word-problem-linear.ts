import { Rational } from "../math/rational.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, rangeValue } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

function render(template: string, values: Record<string, number>): string {
  return template.replace(/\{([a-z]+)\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

export const wordProblemLinear: Family = {
  id: "word-problem-linear",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.c) - Number(problem.b), Number(problem.a));
  },
  generate({ rng, level, calibration, params }): ItemDraft {
    const max = Math.max(4, calibration.coefficientRange[1]);
    const bound = Math.max(1, Math.floor(Math.sqrt(max / 2)));
    const bounded: [number, number] = [-bound, bound];
    const templates =
      params && Array.isArray(params.templates)
        ? params.templates.filter((entry): entry is string => typeof entry === "string")
        : [];
    const hasTemplates = templates.length > 0;
    const a = rng.int(1, Math.max(1, bound));
    const root = hasTemplates
      ? rng.int(0, Math.max(0, bound))
      : rangeValue(rng, bounded, { allowZero: true });
    const b = hasTemplates
      ? rng.int(0, Math.max(0, bound))
      : rangeValue(rng, bounded, { allowZero: true });
    const c = a * root + b;
    const answer = Rational.of(c - b, a);
    const fallback = `$${a}x ${b < 0 ? "-" : "+"} ${Math.abs(b)} = ${c}$`;
    const stem = render(hasTemplates ? rng.pick(templates) : fallback, { a, b, c });
    const pool = [
      `Read the problem and choose the unknown.`,
      `Translate the words into an equation.`,
      `The equation is ${fallback}.`,
      `Subtract ${b} from both sides.`,
      `$${a}x = ${c - b}$`,
      `Divide both sides by ${a}.`,
      `Check the answer in the original sentence.`,
      `$${answer.toString()}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const inverted = c === b ? answer.add(Rational.one) : Rational.of(a, c - b);
    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      [
        {
          value: Rational.of(c + b, a).toString(),
          display: money(Rational.of(c + b, a)),
          error: "added-instead-of-subtracting",
        },
        {
          value: inverted.toString(),
          display: money(inverted),
          error: "inverted-ratio",
        },
        { value: answer.neg().toString(), display: money(answer.neg()), error: "sign-error" },
        ...perturb(answer),
      ],
    );
    return {
      family: "word-problem-linear",
      level,
      type: "single_choice",
      stem: [stem],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a, b, c],
      stepCount: solution.length,
      problem: { a, b, c },
    };
  },
};
