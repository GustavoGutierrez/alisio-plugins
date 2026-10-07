import { Rational } from "../math/rational.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled, prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

/** Factor bounds derived from the level range: tables at the low end, two digits at the top. */
function factorRange(range: [number, number]): [number, number] {
  const low = Math.max(2, range[0]);
  const high = Math.max(low, range[1]);
  const cap = Math.max(low, Math.min(high, Math.max(9, Math.min(99, Math.floor(high / 3)))));
  const floor = Math.min(cap, Math.max(low, Math.ceil(cap / 10)));
  return [floor, cap];
}

/** Multiplication of naturals, scaling from single-digit tables to two-digit factors. */
export const multiplication: Family = {
  id: "multiplication",
  solve(problem: Record<string, unknown>): Rational {
    return Rational.of(Number(problem.a) * Number(problem.b));
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const [low, cap] = factorRange(calibration.coefficientRange);
    const a = rng.int(low, cap);
    const b = rng.int(low, cap);
    const answer = Rational.of(a * b);
    const tens = Math.floor(b / 10);
    const units = b % 10;

    const lines = ["Identifica los factores.", "Recuerda la tabla de multiplicar."];
    if (b >= 10) {
      lines.push("Descompón el segundo factor en decenas y unidades.");
      lines.push(`$${b} = ${tens * 10} + ${units}$`);
      if (tens > 0) lines.push(`$${a} \\times ${tens * 10} = ${a * tens * 10}$`);
      if (units > 0) lines.push(`$${a} \\times ${units} = ${a * units}$`);
      lines.push(`$${a * tens * 10} + ${a * units} = ${a * b}$`);
    } else {
      lines.push(`$${a} \\times ${b} = ${a * b}$`);
    }
    lines.push("Comprueba el resultado con una suma repetida.", "El producto es:", `$${a * b}$`);

    const candidates: OptionCandidate[] = [
      {
        value: Rational.of(a + b).toString(),
        display: money(Rational.of(a + b)),
        error: "added-instead",
      },
    ];
    if (b >= 10) {
      if (units > 0) {
        candidates.push({
          value: Rational.of(a * units).toString(),
          display: money(Rational.of(a * units)),
          error: "multiplied-units-only",
        });
      }
      if (tens > 0) {
        candidates.push({
          value: Rational.of(a * tens).toString(),
          display: money(Rational.of(a * tens)),
          error: "multiplied-tens-only",
        });
      }
    }
    const nextFactor = Rational.of(a * (b + 1));
    candidates.push({
      value: nextFactor.toString(),
      display: money(nextFactor),
      error: "off-by-one-factor",
    });
    const offUp = answer.add(Rational.one);
    candidates.push({ value: offUp.toString(), display: money(offUp), error: "off-by-one" });
    const offDown = answer.sub(Rational.one);
    if (offDown.sign() >= 0) {
      candidates.push({ value: offDown.toString(), display: money(offDown), error: "off-by-one" });
    }
    candidates.push(...perturb(answer));

    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      candidates,
    );
    const solution = pooled(lines, rng, calibration);
    const expr = `$${a} \\times ${b}$`;
    return {
      family: "multiplication",
      level,
      type: "single_choice",
      stem: [prompt(rng, prompts, "Calcula el producto: {expr}", expr)],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [a, b],
      stepCount: solution.length,
      problem: { a, b },
    };
  },
};
