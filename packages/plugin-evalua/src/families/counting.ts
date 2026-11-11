import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, thousands, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "outfits" | "with-repetition" | "without-repetition" | "arrangements";

/** `n · (n-1) · … · (n-k+1)`: ordered choices of `k` out of `n` without repetition. */
export function falling(n: number, k: number): number {
  let out = 1;
  for (let i = 0; i < k; i += 1) out *= n - i;
  return out;
}

export const factorial = (n: number): number => falling(n, n);

/** Code alphabets: how many symbols and how a student would call them. */
const ALPHABETS = [
  { size: 10, name: "dígitos (del $0$ al $9$)" },
  { size: 5, name: "vocales" },
  { size: 4, name: "colores" },
  { size: 6, name: "caras de un dado" },
  { size: 8, name: "letras de la A a la H" },
];

const OUTFITS = [
  { items: ["camisas", "pantalones", "pares de zapatos"], who: "Luis" },
  { items: ["entradas", "platos fuertes", "postres"], who: "Un restaurante ofrece" },
  { items: ["sabores de helado", "salsas", "toppings"], who: "Una heladería tiene" },
];

/** Multiplicative principle, ordered choices with and without repetition, and n! (DBA 9 #11). */
export const counting: Family = {
  id: "counting",
  solve(problem: Record<string, unknown>): Rational {
    const sizes = (problem.sizes as unknown[]).map(Number);
    const n = Number(problem.n);
    const k = Number(problem.k);
    switch (problem.variant as Variant) {
      case "outfits":
        return Rational.of(sizes.reduce((product, size) => product * size, 1));
      case "with-repetition":
        return Rational.of(n ** k);
      case "without-repetition":
        return Rational.of(falling(n, k));
      default:
        return Rational.of(factorial(n));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["outfits"],
        ["outfits", "with-repetition"],
        ["with-repetition", "without-repetition", "arrangements"],
        ["without-repetition", "arrangements", "with-repetition"],
      ]),
    );
    const family = "counting";
    const ask = (text: string) => prompt(rng, prompts, text, "");

    if (variant === "outfits") {
      const context = rng.pick(OUTFITS);
      const stages = index === 0 ? 2 : 3;
      const sizes = Array.from({ length: stages }, () => rng.int(2, index === 0 ? 4 : 6));
      const total = sizes.reduce((product, size) => product * size, 1);
      const listing = sizes
        .map((size, position) => `$${size}$ ${context.items[position]}`)
        .join(", ")
        .replace(/, ([^,]*)$/, " y $1");
      const figure: FigureSpec = {
        kind: "tree-diagram",
        params: {
          stages: sizes.map((size, position) =>
            Array.from({ length: size }, (_, i) => `${"ABC"[position]}${i + 1}`),
          ),
        },
      };
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `${context.who} ${listing}. Si se escoge uno de cada tipo, ¿cuántas combinaciones distintas hay?`,
          ),
          ...(total <= 16 ? [{ figure }] : []),
        ],
        correct: numberChoice(total, "none"),
        distractors: [
          numberChoice(
            sizes.reduce((sum, size) => sum + size, 0),
            "added-instead",
          ),
          numberChoice(
            stages === 2 ? Math.max(...sizes) : (sizes[0] ?? 1) * (sizes[1] ?? 1),
            stages === 2 ? "counted-one-stage" : "forgot-a-stage",
          ),
          numberChoice(total * 2, "doubled"),
        ],
        pool: [
          "Principio multiplicativo: si cada elección es independiente, se multiplican las opciones.",
          `Opciones por etapa: ${sizes.map((size) => `$${size}$`).join(", ")}.`,
          `$${sizes.join(" \\times ")} = ${total}$`,
          "El número de combinaciones es:",
          math(total),
        ],
        numericValues: sizes,
        problem: { variant, sizes, n: 0, k: 0 },
      });
    }

    if (variant === "arrangements") {
      const n = rng.int(3, index >= 3 ? 8 : 6);
      const answer = factorial(n);
      const question = rng.pick([
        `¿De cuántas maneras distintas se pueden sentar $${n}$ amigos en una fila de $${n}$ sillas?`,
        `¿De cuántas maneras distintas se pueden ordenar $${n}$ libros diferentes en un estante?`,
        `En una carrera con $${n}$ corredores, ¿de cuántas maneras distintas pueden llegar todos a la meta, sin empates?`,
      ]);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(question)],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(n * n, "squared-n"),
          numberChoice((n * (n + 1)) / 2, "added-instead"),
          numberChoice(answer / n, "stopped-one-factor-early"),
        ],
        pool: [
          "El primer lugar tiene $n$ opciones, el segundo $n - 1$, y así sucesivamente.",
          `$${n}! = ${Array.from({ length: n }, (_, i) => n - i).join(" \\cdot ")}$`,
          `$${n}! = ${thousands(answer)}$`,
          "El número de ordenaciones es:",
          math(answer),
        ],
        numericValues: [n],
        problem: { variant, sizes: [], n, k: n },
      });
    }

    // Codes, or ordered draws, of k symbols from an alphabet of n: with or without repetition.
    const alphabet = rng.pick(ALPHABETS);
    const n = alphabet.size;
    const k = rng.int(2, index >= 3 ? 4 : 3);
    const repeat = variant === "with-repetition";
    const answer = repeat ? n ** k : falling(n, k);
    const draw = rng.int(0, 1) === 0;
    const question = draw
      ? `Una urna tiene $${n}$ bolas numeradas. Se sacan $${k}$ bolas una tras otra ${repeat ? "con reemplazo" : "sin reemplazo"} y se anota el orden. ¿Cuántos resultados ordenados hay?`
      : `Se forma un código de $${k}$ símbolos con ${alphabet.name}, ${repeat ? "y se pueden repetir" : "sin repetir ninguno"}. ¿Cuántos códigos distintos hay?`;
    const factors = repeat
      ? Array.from({ length: k }, () => n)
      : Array.from({ length: k }, (_, i) => n - i);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(question)],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(
          repeat ? falling(n, k) : n ** k,
          repeat ? "assumed-no-repetition" : "allowed-repetition",
        ),
        numberChoice(n * k, "multiplied-by-the-positions"),
        numberChoice(k ** n === answer ? answer + n : k ** n, "swapped-base-and-exponent"),
        numberChoice(falling(n, k) / factorial(k), "ignored-the-order"),
      ],
      pool: [
        repeat
          ? "Con repetición, cada posición tiene todas las opciones."
          : "Sin repetición, cada posición tiene una opción menos que la anterior.",
        `Posiciones: $${k}$. Opciones para la primera: $${n}$.`,
        `$${factors.join(" \\times ")}$`,
        `$= ${thousands(answer)}$`,
        "El número de resultados es:",
        math(answer),
      ],
      numericValues: [n, k],
      problem: { variant, sizes: [], n, k },
    });
  },
};
