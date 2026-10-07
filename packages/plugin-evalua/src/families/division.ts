import { Rational } from "../math/rational.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled, prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Ask = "quotient" | "quotient-remainder";

function split(dividend: number, divisor: number): { quotient: number; remainder: number } {
  return { quotient: Math.floor(dividend / divisor), remainder: dividend % divisor };
}

function twoPart(quotient: number, remainder: number): string {
  return `$${quotient}$ con residuo $${remainder}$`;
}

/** Exact division and division with remainder, asking for the quotient pair at higher levels. */
export const division: Family = {
  id: "division",
  solve(problem: Record<string, unknown>): Rational | string {
    const { quotient, remainder } = split(Number(problem.dividend), Number(problem.divisor));
    if (problem.ask === "quotient-remainder") return `${quotient}|${remainder}`;
    return Rational.of(quotient);
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const high = Math.max(2, Math.floor(calibration.coefficientRange[1]));
    const maxDivisor = Math.min(12, Math.max(2, Math.floor(high / 3)));
    let divisor = rng.int(2, maxDivisor);
    let remainder = rng.int(0, divisor - 1);
    if (high - divisor - remainder < 0) {
      divisor = 2;
      remainder = 0;
    }
    const maxQuotient = Math.max(1, Math.floor((high - remainder) / divisor));
    const quotient = rng.int(1, maxQuotient);
    const dividend = divisor * quotient + remainder;
    const ask: Ask =
      calibration.steps[0] >= 3 && rng.int(0, 1) === 1 ? "quotient-remainder" : "quotient";

    const product = divisor * quotient;
    // Spanish solution lines are exam-facing data, not identifiers.
    const pool = [
      "Identifica el dividendo y el divisor.",
      `Dividendo: $${dividend}$, divisor: $${divisor}$.`,
      `Busca cuántas veces cabe $${divisor}$ en $${dividend}$.`,
      `$${divisor} \\times ${quotient} = ${product}$`,
      remainder > 0 ? `$${dividend} - ${product} = ${remainder}$` : "La división es exacta.",
      remainder > 0
        ? `El residuo $${remainder}$ es menor que el divisor $${divisor}$.`
        : "El residuo es $0$.",
      ask === "quotient-remainder"
        ? `Cociente: $${quotient}$, residuo: $${remainder}$.`
        : `El cociente es $${quotient}$.`,
      ask === "quotient-remainder"
        ? `La respuesta es $${quotient}$ con residuo $${remainder}$.`
        : `La respuesta es $${quotient}$.`,
    ];
    const solution = pooled(pool, rng, calibration);

    const candidates: OptionCandidate[] = [];
    if (ask === "quotient-remainder") {
      candidates.push({
        value: `${quotient}|0`,
        display: twoPart(quotient, 0),
        error: "forgot-remainder",
      });
      if (remainder > 0) {
        candidates.push({
          value: `${remainder}|${quotient}`,
          display: twoPart(remainder, quotient),
          error: "used-remainder-as-quotient",
        });
      }
      candidates.push({
        value: `${quotient + 1}|${remainder}`,
        display: twoPart(quotient + 1, remainder),
        error: "off-by-one",
      });
      candidates.push({
        value: `0|${divisor}`,
        display: twoPart(0, divisor),
        error: "swapped-operands",
      });
      candidates.push({
        value: `${quotient}|${remainder + divisor}`,
        display: twoPart(quotient, remainder + divisor),
        error: "remainder-not-less-than-divisor",
      });
      candidates.push({
        value: `${quotient + 2}|${remainder}`,
        display: twoPart(quotient + 2, remainder),
        error: "off-by-two",
      });
    } else {
      if (remainder > 0) {
        candidates.push({
          value: Rational.of(remainder).toString(),
          display: money(Rational.of(remainder)),
          error: "used-remainder-as-quotient",
        });
      }
      candidates.push({
        value: Rational.of(divisor).toString(),
        display: money(Rational.of(divisor)),
        error: "swapped-operands",
      });
      const offUp = Rational.of(quotient + 1);
      candidates.push({ value: offUp.toString(), display: money(offUp), error: "off-by-one" });
      const offDown = Rational.of(Math.max(0, quotient - 1));
      candidates.push({ value: offDown.toString(), display: money(offDown), error: "off-by-one" });
      const sum = Rational.of(quotient + remainder);
      candidates.push({ value: sum.toString(), display: money(sum), error: "added-remainder" });
      candidates.push(...perturb(Rational.of(quotient)));
    }
    const answer: OptionCandidate =
      ask === "quotient-remainder"
        ? {
            value: `${quotient}|${remainder}`,
            display: twoPart(quotient, remainder),
            error: "none",
          }
        : {
            value: Rational.of(quotient).toString(),
            display: money(Rational.of(quotient)),
            error: "none",
          };
    const options = assembleOptions(rng, answer, candidates);
    const expr = `$${dividend} \\div ${divisor}$`;
    const fallback =
      ask === "quotient-remainder"
        ? "Halla el cociente y el residuo de {expr}"
        : "Resuelve la división: {expr}";
    return {
      family: "division",
      level,
      type: "single_choice",
      stem: [prompt(rng, prompts, fallback, expr)],
      options,
      answer: { canonical: answer.value, display: answer.display },
      solution,
      numericValues: [dividend, divisor],
      stepCount: solution.length,
      problem: { dividend, divisor, ask },
    };
  },
};
