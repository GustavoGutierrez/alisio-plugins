import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { distinctInts, finishDraft, levelHigh, levelIndex, math, numberChoice } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, ItemDraft } from "./types.js";

type Variant = "digit-value" | "compose" | "greatest" | "least";

const PLACES = [
  { singular: "unidad", plural: "unidades" },
  { singular: "decena", plural: "decenas" },
  { singular: "centena", plural: "centenas" },
  { singular: "unidad de mil", plural: "unidades de mil" },
];

/** Digits of a natural number, units first. */
const digitsOf = (value: number): number[] => [...String(value)].reverse().map(Number);

function hasUniqueDigit(value: number): boolean {
  const digits = digitsOf(value);
  return digits.some(
    (digit) => digit !== 0 && digits.filter((other) => other === digit).length === 1,
  );
}

function placeText(count: number, place: number): string {
  const name = PLACES[place];
  if (name === undefined) throw new Error(`place-value: no name for place ${place}`);
  return `$${count}$ ${count === 1 ? name.singular : name.plural}`;
}

function listText(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/** Numbers with the same digit count as `value`: its digit rearrangements and close neighbours. */
function rivals(value: number, low: number, high: number): Array<{ value: number; error: string }> {
  const digits = String(value);
  const out: Array<{ value: number; error: string }> = [];
  for (let i = 0; i < digits.length; i += 1) {
    for (let j = i + 1; j < digits.length; j += 1) {
      const swapped = [...digits];
      [swapped[i], swapped[j]] = [swapped[j] ?? "0", swapped[i] ?? "0"];
      if (swapped[0] !== "0")
        out.push({ value: Number(swapped.join("")), error: "digit-order-confusion" });
    }
  }
  const lead = 10 ** (digits.length - 1);
  for (const delta of [-lead, lead, -1, 1, -10, 10]) {
    out.push({ value: value + delta, error: "compared-wrong-place" });
  }
  return out.filter(
    (entry) =>
      entry.value !== value &&
      entry.value >= low &&
      entry.value <= high &&
      String(entry.value).length === digits.length,
  );
}

/** Place value of natural numbers: digit values, composing from places, comparing (DBA 1-2 #3). */
export const placeValue: Family = {
  id: "place-value",
  solve(problem: Record<string, unknown>): Rational {
    const variant = problem.variant as Variant;
    if (variant === "digit-value") {
      return Rational.of(Number(problem.digit) * 10 ** Number(problem.place));
    }
    if (variant === "compose") {
      const parts = problem.parts as Array<{ count: number; place: number }>;
      return Rational.of(parts.reduce((sum, part) => sum + part.count * 10 ** part.place, 0));
    }
    const numbers = (problem.numbers as unknown[]).map(Number);
    return Rational.of(variant === "greatest" ? Math.max(...numbers) : Math.min(...numbers));
  },
  generate({ rng, level, calibration, prompts }): ItemDraft {
    const high = levelHigh(calibration, 9999, 20);
    const low = 10;
    const variants: Variant[] = ["digit-value", "compose", "greatest", "least"];
    const variant = rng.pick(variants);
    let value = rng.int(low, high);
    // A digit-value question names its digit, so that digit must appear only once in the number.
    for (
      let guard = 0;
      variant === "digit-value" && guard < 20 && !hasUniqueDigit(value);
      guard += 1
    ) {
      value = rng.int(low, high);
    }
    if (variant === "digit-value" && !hasUniqueDigit(value)) value = low + 2;
    const digits = digitsOf(value);
    if (variant === "digit-value")
      return digitValue(rng, level, calibration, prompts, value, digits);
    if (variant === "compose") return compose(rng, level, calibration, prompts, value, digits);
    return compare(rng, level, calibration, prompts, value, variant, low, high);
  },
};

type Ctx = Parameters<Family["generate"]>[0];

function digitValue(
  rng: Rng,
  level: Ctx["level"],
  calibration: Ctx["calibration"],
  prompts: Ctx["prompts"],
  value: number,
  digits: number[],
): ItemDraft {
  const unique = digits
    .map((digit, place) => ({ digit, place }))
    .filter(({ digit }) => digit !== 0 && digits.filter((other) => other === digit).length === 1);
  const chosen = rng.pick(unique.length > 0 ? unique : [{ digit: digits[0] ?? 1, place: 0 }]);
  const { digit, place } = chosen;
  const answer = digit * 10 ** place;
  const instruction = prompt(
    rng,
    prompts,
    `En el número {expr}, ¿cuál es el valor posicional de la cifra $${digit}$?`,
    `$${value}$`,
  );
  return finishDraft({
    family: "place-value",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: numberChoice(answer, "none"),
    distractors: [
      numberChoice(digit, "face-value"),
      numberChoice(digit * 10 ** (place + 1), "wrong-place"),
      numberChoice(place > 0 ? digit * 10 ** (place - 1) : digit * 100, "wrong-place"),
      numberChoice(value, "whole-number"),
    ],
    pool: [
      `Escribe las cifras de $${value}$ de derecha a izquierda: unidades, decenas, centenas.`,
      `La cifra $${digit}$ está en el lugar de las ${PLACES[place]?.plural ?? "unidades"}.`,
      `Cada ${PLACES[place]?.singular ?? "unidad"} vale $${10 ** place}$.`,
      `$${digit} \\times ${10 ** place} = ${answer}$`,
      "El valor posicional es:",
      math(answer),
    ],
    numericValues: [value, digit],
    problem: { variant: "digit-value", value, digit, place },
  });
}

function compose(
  rng: Rng,
  level: Ctx["level"],
  calibration: Ctx["calibration"],
  prompts: Ctx["prompts"],
  value: number,
  digits: number[],
): ItemDraft {
  const parts = digits
    .map((count, place) => ({ count, place }))
    .filter((part) => part.count !== 0)
    .reverse();
  // From intermedio on the places are listed out of order, a classic trap.
  const listed = levelIndex(level) >= 1 ? rng.shuffle(parts) : parts;
  const text = listText(listed.map((part) => placeText(part.count, part.place)));
  const reversed = Number([...String(value)].reverse().join(""));
  const listedDigits = Number(listed.map((part) => part.count).join(""));
  const noGaps = Number(parts.map((part) => part.count).join(""));
  const instruction = prompt(rng, prompts, "¿Qué número se forma con {expr}?", text);
  return finishDraft({
    family: "place-value",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: numberChoice(value, "none"),
    distractors: [
      numberChoice(listedDigits, "wrote-in-listed-order"),
      numberChoice(noGaps, "ignored-empty-place"),
      numberChoice(reversed, "reversed-order"),
      numberChoice(
        parts.reduce((sum, part) => sum + part.count, 0),
        "added-the-digits",
      ),
    ],
    pool: [
      `Ordena los grupos de mayor a menor: ${listText(parts.map((part) => placeText(part.count, part.place)))}.`,
      ...parts.map(
        (part) => `$${part.count} \\times ${10 ** part.place} = ${part.count * 10 ** part.place}$`,
      ),
      `Suma los valores: $${parts.map((part) => part.count * 10 ** part.place).join(" + ")} = ${value}$`,
      "El número es:",
      math(value),
    ],
    numericValues: parts.map((part) => part.count),
    problem: { variant: "compose", parts: parts.map(({ count, place }) => ({ count, place })) },
  });
}

function compare(
  rng: Rng,
  level: Ctx["level"],
  calibration: Ctx["calibration"],
  prompts: Ctx["prompts"],
  seed: number,
  variant: "greatest" | "least",
  low: number,
  high: number,
): ItemDraft {
  const pool = rivals(seed, low, high);
  const picked = new Map<number, string>();
  for (const entry of rng.shuffle(pool)) {
    if (picked.size >= 3) break;
    if (!picked.has(entry.value)) picked.set(entry.value, entry.error);
  }
  for (const extra of distinctInts(rng, 3, low, high, new Set([seed, ...picked.keys()]))) {
    if (picked.size >= 3) break;
    picked.set(extra, "compared-wrong-place");
  }
  const numbers = rng.shuffle([seed, ...picked.keys()]);
  const answer = variant === "greatest" ? Math.max(...numbers) : Math.min(...numbers);
  const word = variant === "greatest" ? "mayor" : "menor";
  const ordered = [...numbers].sort((a, b) => (variant === "greatest" ? b - a : a - b));
  const instruction = prompt(
    rng,
    prompts,
    `Observa los números {expr}. ¿Cuál es el ${word}?`,
    listText(numbers.map((value) => `$${value}$`)),
  );
  return finishDraft({
    family: "place-value",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: numberChoice(answer, "none"),
    distractors: numbers
      .filter((value) => value !== answer)
      .map((value) => numberChoice(value, picked.get(value) ?? "digit-order-confusion")),
    pool: [
      "Compara primero cuántas cifras tiene cada número.",
      "Si tienen las mismas cifras, compara de izquierda a derecha.",
      `Ordenados de ${word} a ${variant === "greatest" ? "menor" : "mayor"}: $${ordered.join(",\\ ")}$`,
      `El número ${word} es:`,
      math(answer),
    ],
    numericValues: numbers,
    problem: { variant, numbers },
    fallback: "none",
  });
}
