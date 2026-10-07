import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled, positiveValue, prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Op = "+" | "-";

interface Term {
  op: Op;
  value: number;
}

function evaluate(start: number, terms: readonly Term[]): Rational {
  let acc = Rational.of(start);
  for (const term of terms) {
    acc = term.op === "+" ? acc.add(Rational.of(term.value)) : acc.sub(Rational.of(term.value));
  }
  return acc;
}

function expression(start: number, terms: readonly Term[]): string {
  const parts = [String(start)];
  for (const term of terms) parts.push(`${term.op} ${term.value}`);
  return parts.join(" ");
}

function maxDigits(values: readonly number[]): number {
  return values.reduce((best, value) => Math.max(best, String(Math.abs(value)).length), 1);
}

/** Addition and subtraction of naturals with two or three terms, kept non-negative. */
export const addSubtract: Family = {
  id: "add-subtract",
  solve(problem: Record<string, unknown>): Rational {
    return evaluate(Number(problem.start), (problem.terms ?? []) as Term[]);
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const start = positiveValue(rng, calibration.coefficientRange);
    const count = rng.int(1, 2);
    const terms: Term[] = [];
    let running = Rational.of(start);
    for (let index = 0; index < count; index += 1) {
      const value = positiveValue(rng, calibration.coefficientRange);
      const canSubtract = running.compare(Rational.of(value)) > 0;
      const op: Op = canSubtract && rng.int(0, 1) === 1 ? "-" : "+";
      running = op === "+" ? running.add(Rational.of(value)) : running.sub(Rational.of(value));
      terms.push({ op, value });
    }
    const answer = evaluate(start, terms);

    const steps: string[] = [];
    let previous = Rational.of(start);
    for (const term of terms) {
      const next =
        term.op === "+"
          ? previous.add(Rational.of(term.value))
          : previous.sub(Rational.of(term.value));
      steps.push(`$${latexRational(previous)} ${term.op} ${term.value} = ${latexRational(next)}$`);
      previous = next;
    }

    const addedInstead = evaluate(
      start,
      terms.map((term) => ({ op: "+" as Op, value: term.value })),
    );
    const wrongLast = evaluate(
      start,
      terms.map((term, index) =>
        index === terms.length - 1
          ? { op: term.op === "+" ? ("-" as Op) : ("+" as Op), value: term.value }
          : term,
      ),
    );
    const power = 10 ** Math.max(1, maxDigits([start, ...terms.map((term) => term.value)]) - 1);

    const candidates: OptionCandidate[] = [];
    if (terms.some((term) => term.op === "-")) {
      candidates.push({
        value: addedInstead.toString(),
        display: money(addedInstead),
        error: "added-instead",
      });
    }
    if (wrongLast.sign() >= 0) {
      candidates.push({
        value: wrongLast.toString(),
        display: money(wrongLast),
        error: "wrong-operation",
      });
    }
    const carryUp = answer.add(Rational.of(power));
    candidates.push({ value: carryUp.toString(), display: money(carryUp), error: "forgot-carry" });
    const carryDown = answer.sub(Rational.of(power));
    if (carryDown.sign() >= 0) {
      candidates.push({
        value: carryDown.toString(),
        display: money(carryDown),
        error: "forgot-borrow",
      });
    }
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
    const pool = [
      "Lee la expresión de izquierda a derecha.",
      "Suma y resta en el orden en que aparecen.",
      "Escribe cada resultado parcial.",
      ...steps,
      "Comprueba que cada resultado parcial siga siendo un número natural.",
      "El resultado final es:",
      `$${latexRational(answer)}$`,
    ];
    const solution = pooled(pool, rng, calibration);
    const expr = `$${expression(start, terms)}$`;
    return {
      family: "add-subtract",
      level,
      type: "single_choice",
      stem: [prompt(rng, prompts, "Calcula: {expr}", expr)],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [start, ...terms.map((term) => term.value)],
      stepCount: solution.length,
      problem: { start, terms },
    };
  },
};
