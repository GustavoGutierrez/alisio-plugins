import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { assembleOptions, type OptionCandidate } from "./options.js";
import { money, perturb, pooled, prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type UnitGroup = "length" | "mass" | "capacity" | "time";

/** Each group maps a unit symbol to how many base units it contains. */
const unitFactors: Record<UnitGroup, Record<string, number>> = {
  length: { mm: 1, cm: 10, dm: 100, m: 1000, km: 1_000_000 },
  mass: { g: 1, kg: 1000, t: 1_000_000 },
  capacity: { mL: 1, L: 1000 },
  time: { s: 1, min: 60, h: 3600, day: 86400 },
};

const unitNames: Record<string, { singular: string; plural: string }> = {
  mm: { singular: "milímetro", plural: "milímetros" },
  cm: { singular: "centímetro", plural: "centímetros" },
  dm: { singular: "decímetro", plural: "decímetros" },
  m: { singular: "metro", plural: "metros" },
  km: { singular: "kilómetro", plural: "kilómetros" },
  g: { singular: "gramo", plural: "gramos" },
  kg: { singular: "kilogramo", plural: "kilogramos" },
  t: { singular: "tonelada", plural: "toneladas" },
  mL: { singular: "mililitro", plural: "mililitros" },
  L: { singular: "litro", plural: "litros" },
  s: { singular: "segundo", plural: "segundos" },
  min: { singular: "minuto", plural: "minutos" },
  h: { singular: "hora", plural: "horas" },
  day: { singular: "día", plural: "días" },
};

function factorOf(symbol: string): number {
  for (const group of Object.values(unitFactors)) {
    const factor = group[symbol];
    if (factor !== undefined) return factor;
  }
  throw new Error(`Unknown unit symbol: ${symbol}`);
}

function pluralName(symbol: string): string {
  const names = unitNames[symbol];
  if (names === undefined) throw new Error(`Unknown unit symbol: ${symbol}`);
  return names.plural;
}

function unitName(symbol: string, value: number): string {
  const names = unitNames[symbol];
  if (names === undefined) throw new Error(`Unknown unit symbol: ${symbol}`);
  return value === 1 ? names.singular : names.plural;
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", "{,}");
}

function rationalOf(value: number): Rational {
  return Number.isInteger(value) ? Rational.of(value) : Rational.of(Math.round(value * 1000), 1000);
}

/** Converted quantities above this stop being useful numbers on a school sheet. */
const MAX_ANSWER = 100_000;

interface Move {
  from: string;
  to: string;
  /** How many `to` units one `from` unit is worth. */
  ratio: number;
  lo: number;
  hi: number;
  /** When set, the quantity must be a multiple of it (conversions to a larger unit). */
  step?: number;
  /** One decimal place is only safe when the ratio keeps the answer a whole number. */
  decimal: boolean;
}

/** Every conversion this level can ask for, inside the range and under the magnitude cap. */
function movesFor(high: number): Move[] {
  const moves: Move[] = [];
  for (const group of Object.values(unitFactors)) {
    const symbols = Object.keys(group);
    for (const from of symbols) {
      for (const to of symbols) {
        if (from === to) continue;
        const ratio = (group[from] ?? 1) / (group[to] ?? 1);
        if (ratio > 1) {
          // The quantity is written in the larger unit, so only it has to fit the level range; the
          // answer is what grows, and the cap keeps it a number worth reading.
          const cap = Math.floor(Math.min(high, MAX_ANSWER / ratio));
          if (cap < 1) continue;
          moves.push({ from, to, ratio, lo: 1, hi: cap, decimal: ratio % 10 === 0 && cap >= 20 });
        } else {
          // Converting upwards only yields a whole answer for a multiple of the ratio.
          const step = 1 / ratio;
          const k = Math.floor(high / step);
          if (k < 1) continue;
          moves.push({ from, to, ratio, lo: step, hi: k * step, step, decimal: false });
        }
      }
    }
  }
  return moves;
}

/** Decimal metric system conversions plus time units (pensamiento métrico). */
export const measurement: Family = {
  id: "measurement",
  solve(problem: Record<string, unknown>): Rational {
    const value = rationalOf(Number(problem.value));
    const from = String(problem.from);
    const to = String(problem.to);
    return value.mul(Rational.of(factorOf(from), factorOf(to)));
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const high = Math.max(2, Math.floor(calibration.coefficientRange[1]));
    const moves = movesFor(high);
    if (moves.length === 0) throw new Error("measurement: no legal conversion for this level");
    const move = rng.pick(moves);
    const { from, to } = move;
    const value =
      move.step === undefined
        ? move.decimal && rng.int(0, 1) === 1
          ? rng.int(10, move.hi * 10) / 10
          : rng.int(move.lo, move.hi)
        : rng.int(1, Math.floor(move.hi / move.step)) * move.step;
    const convertUp = move.ratio < 1;
    const denom = move.ratio >= 1 ? move.ratio : 1 / move.ratio;

    const fromFactor = factorOf(from);
    const toFactor = factorOf(to);
    const ratio = Rational.of(fromFactor, toFactor);
    const valueRational = rationalOf(value);
    const answer = valueRational.mul(ratio);
    const inverted = valueRational.div(ratio);

    const candidates: OptionCandidate[] = [
      {
        value: answer.mul(Rational.of(10)).toString(),
        display: money(answer.mul(Rational.of(10))),
        error: "power-of-ten-slip",
      },
      {
        value: answer.div(Rational.of(10)).toString(),
        display: money(answer.div(Rational.of(10))),
        error: "power-of-ten-slip",
      },
      { value: inverted.toString(), display: money(inverted), error: "inverted-conversion" },
      {
        value: answer.add(Rational.one).toString(),
        display: money(answer.add(Rational.one)),
        error: "off-by-one",
      },
      {
        value: answer.sub(Rational.one).toString(),
        display: money(answer.sub(Rational.one)),
        error: "off-by-one",
      },
      ...perturb(answer),
    ];

    const options = assembleOptions(
      rng,
      { value: answer.toString(), display: money(answer), error: "none" },
      candidates,
    );
    const pool = [
      `Compara las unidades: ${pluralName(from)} y ${pluralName(to)}.`,
      convertUp
        ? `La unidad ${pluralName(to)} es mayor: hay que dividir entre $${denom}$.`
        : `La unidad ${pluralName(to)} es menor: hay que multiplicar por $${denom}$.`,
      convertUp
        ? `$${numberText(value)} \\div ${denom} = ${latexRational(answer)}$`
        : `$${numberText(value)} \\times ${denom} = ${latexRational(answer)}$`,
      `Escribe el resultado con la unidad ${pluralName(to)}.`,
      "Comprueba que el resultado tenga sentido.",
      "Revisa la operación.",
      "El resultado es:",
      `$${latexRational(answer)}$ ${unitName(to, answer.toNumber())}`,
    ];
    const solution = pooled(pool, rng, calibration);
    const number = numberText(value);
    const expr = `$${number}$ ${unitName(from, value)}`;
    const askCount = rng.int(0, 1) === 1;
    const fallback = askCount
      ? `¿Cuántos ${pluralName(to)} hay en $${number}$ ${unitName(from, value)}?`
      : `Convierte {expr} a ${pluralName(to)}.`;
    return {
      family: "measurement",
      level,
      type: "single_choice",
      stem: [prompt(rng, prompts, fallback, expr)],
      options,
      answer: { canonical: answer.toString(), display: money(answer) },
      solution,
      numericValues: [value],
      stepCount: solution.length,
      problem: { value, from, to },
    };
  },
};
