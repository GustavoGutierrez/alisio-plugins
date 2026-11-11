import { Rational } from "../math/rational.js";
import { finishDraft, levelHigh, levelIndex, numberChoice, pesos } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "count" | "change" | "how-many";

/** Colombian coins and bills. A denomination is a unit, like a metre: only the counts and the
 * prices that are not a coin or bill are calibrated numbers (see measurement's unit factors). */
const COINS = [50, 100, 200, 500, 1000] as const;
const BILLS = [2000, 5000, 10000, 20000, 50000, 100000] as const;

const ITEMS = [
  { singular: "lápiz", plural: "lápices" },
  { singular: "borrador", plural: "borradores" },
  { singular: "cuaderno", plural: "cuadernos" },
  { singular: "jugo", plural: "jugos" },
  { singular: "pan", plural: "panes" },
  { singular: "chocolatina", plural: "chocolatinas" },
] as const;

const moneyChoice = (value: number, error: string): OptionCandidate => ({
  ...numberChoice(value, error),
  display: pesos(value),
});

const pieceName = (value: number, count: number): string => {
  const kind = value >= 2000 ? "billete" : "moneda";
  return `${count === 1 ? kind : `${kind}s`} de ${pesos(value)}`;
};

/** Counting coins, giving change and how many items a bill buys, in pesos (DBA 2-3 #1). */
export const moneyProblems: Family = {
  id: "money-problems",
  solve(problem: Record<string, unknown>): Rational {
    if (problem.variant === "count") {
      const pieces = problem.pieces as Array<{ value: number; count: number }>;
      return Rational.of(pieces.reduce((sum, piece) => sum + piece.value * piece.count, 0));
    }
    const price = Number(problem.price);
    const bill = Number(problem.bill);
    if (problem.variant === "how-many") return Rational.of(Math.floor(bill / price));
    return Rational.of(bill - Number(problem.quantity) * price);
  },
  generate(context: FamilyContext): ItemDraft {
    const index = levelIndex(context.level);
    const variants: Variant[] =
      index === 0 ? ["count"] : index === 1 ? ["count", "change"] : ["count", "change", "how-many"];
    const variant = context.rng.pick(variants);
    if (variant === "count") return count(context, index);
    return purchase(context, index, variant);
  },
};

function count({ rng, level, calibration, prompts }: FamilyContext, index: number): ItemDraft {
  const maxCount = levelHigh(calibration, 9);
  const kinds = index === 0 ? rng.int(1, 2) : Math.min(index + 1, 3);
  const pool = rng.shuffle(index === 0 ? [...COINS] : [...COINS, ...BILLS.slice(0, 3)]);
  const pieces = pool
    .slice(0, Math.max(1, kinds))
    .sort((a, b) => b - a)
    .map((value) => ({ value, count: rng.int(1, maxCount) }));
  const total = pieces.reduce((sum, piece) => sum + piece.value * piece.count, 0);
  const pieceCount = pieces.reduce((sum, piece) => sum + piece.count, 0);
  const largest = pieces[0]?.value ?? 100;
  const smallest = pieces[pieces.length - 1]?.value ?? 50;
  const text = pieces.map((piece) => `$${piece.count}$ ${pieceName(piece.value, piece.count)}`);
  const listed =
    text.length === 1 ? text[0] : `${text.slice(0, -1).join(", ")} y ${text[text.length - 1]}`;
  const instruction = prompt(
    rng,
    prompts,
    "Sara tiene {expr}. ¿Cuánto dinero tiene en total?",
    listed ?? "",
  );
  return finishDraft({
    family: "money-problems",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: moneyChoice(total, "none"),
    distractors: [
      moneyChoice(pieceCount * largest, "used-one-denomination"),
      moneyChoice(total + smallest, "miscounted-a-coin"),
      moneyChoice(Math.max(smallest, total - smallest), "miscounted-a-coin"),
      moneyChoice(
        pieces.reduce((sum, piece) => sum + piece.value, 0),
        "ignored-the-counts",
      ),
      moneyChoice(total * 10, "place-value-slip"),
      moneyChoice(total + (smallest === 50 ? 100 : 50), "miscounted-a-coin"),
      moneyChoice(total * 2, "counted-twice"),
    ],
    pool: [
      "Agrupa las monedas y billetes del mismo valor.",
      ...pieces.map(
        (piece) =>
          `$${piece.count}$ de ${pesos(piece.value)} son ${pesos(piece.count * piece.value)}.`,
      ),
      `Suma los grupos: ${pesos(total)}.`,
      "En total tiene:",
      pesos(total),
    ],
    numericValues: pieces.map((piece) => piece.count),
    problem: { variant: "count", pieces },
    fallback: "none",
  });
}

function purchase(
  { rng, level, calibration, prompts }: FamilyContext,
  index: number,
  variant: "change" | "how-many",
): ItemDraft {
  const item = rng.pick(ITEMS);
  // Intermedio prices are a coin or bill; avanzado any multiple of $50, genio of $100.
  const price =
    index === 1
      ? rng.pick(COINS.slice(1))
      : index === 2
        ? rng.int(2, Math.floor(levelHigh(calibration, 1000) / 50)) * 50
        : rng.int(5, Math.floor(levelHigh(calibration, 9999) / 100)) * 100;
  const priced =
    (COINS as readonly number[]).includes(price) || (BILLS as readonly number[]).includes(price);
  if (variant === "how-many") {
    const bill = BILLS.find((value) => value >= price * 2) ?? 100000;
    const answer = Math.floor(bill / price);
    const rest = bill - answer * price;
    const instruction = prompt(
      rng,
      prompts,
      `Cada ${item.singular} cuesta ${pesos(price)}. ¿Cuántos ${item.plural} puedes comprar como máximo con un billete de ${pesos(bill)}?`,
      "",
    );
    return finishDraft({
      family: "money-problems",
      level,
      rng,
      calibration,
      stem: [instruction],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(rest === 0 ? answer * 2 : answer + 1, "rounded-up"),
        numberChoice(Math.max(1, answer - 1), "off-by-one"),
        numberChoice(answer + 2, "off-by-two"),
      ],
      pool: [
        `Divide el dinero entre el precio: ${pesos(bill)} entre ${pesos(price)}.`,
        `$${answer} \\times ${price} = ${answer * price}$`,
        `Sobran ${pesos(rest)}, que no alcanzan para otro ${item.singular}.`,
        "Puedes comprar:",
        `$${answer}$`,
      ],
      numericValues: priced ? [] : [price],
      problem: { variant, price, bill },
    });
  }
  const maxQuantity = levelHigh(calibration, index >= 3 ? 9 : 6);
  const quantity = rng.int(2, maxQuantity);
  const total = quantity * price;
  const bill = BILLS.find((value) => value > total) ?? 100000;
  const answer = bill - total;
  const instruction = prompt(
    rng,
    prompts,
    `Compras $${quantity}$ ${item.plural} de ${pesos(price)} cada uno y pagas con un billete de ${pesos(bill)}. ¿Cuánto te devuelven?`,
    "",
  );
  return finishDraft({
    family: "money-problems",
    level,
    rng,
    calibration,
    stem: [instruction],
    correct: moneyChoice(answer, "none"),
    distractors: [
      moneyChoice(total, "forgot-to-subtract"),
      moneyChoice(bill - price, "forgot-the-quantity"),
      moneyChoice(answer + 100, "miscounted-a-coin"),
      moneyChoice(Math.max(50, answer - 100), "miscounted-a-coin"),
    ],
    pool: [
      `Primero calcula cuánto cuestan los ${item.plural}.`,
      `$${quantity} \\times ${price} = ${total}$`,
      `Luego resta del billete: $${bill} - ${total} = ${answer}$`,
      "Te devuelven:",
      pesos(answer),
    ],
    numericValues: priced ? [quantity] : [quantity, price],
    problem: { variant, quantity, price, bill },
    fallback: "none",
  });
}
