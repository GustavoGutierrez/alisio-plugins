import { Rational } from "../math/rational.js";
import { factorial, falling } from "./counting.js";
import { finishDraft, levelIndex, math, numberChoice, thousands, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant =
  | "permutation"
  | "combination"
  | "anagram"
  | "circular"
  | "mixed-committee"
  | "at-least-one"
  | "handshakes";

/** `C(n, k) = n! / (k! (n - k)!)`, exact for the small values used here. */
export const choose = (n: number, k: number): number =>
  k < 0 || k > n ? 0 : falling(n, k) / factorial(k);

/** Words whose letters repeat, with the repetition counts (for anagrams). */
const WORDS: ReadonlyArray<{ word: string; repeats: number[] }> = [
  { word: "CASA", repeats: [2] },
  { word: "PAPA", repeats: [2, 2] },
  { word: "MAMA", repeats: [2, 2] },
  { word: "COCO", repeats: [2, 2] },
  { word: "ANA", repeats: [2] },
  { word: "PERRO", repeats: [2] },
  { word: "ARROZ", repeats: [2] },
  { word: "SALSA", repeats: [2, 2] },
  { word: "LLAMA", repeats: [2, 2] },
  { word: "TOMATE", repeats: [2] },
  { word: "BANANA", repeats: [3, 2] },
  { word: "CARRO", repeats: [2] },
  { word: "PALMA", repeats: [2] },
  { word: "OSO", repeats: [2] },
];

const ROLES = [
  { group: "estudiantes", roles: "presidente, vicepresidente y secretario", k: 3 },
  { group: "corredores", roles: "primer, segundo y tercer puesto", k: 3 },
  { group: "candidatos", roles: "presidente y tesorero", k: 2 },
];

const GROUPS = [
  { pool: "estudiantes", pick: "un comité" },
  { pool: "jugadores", pick: "un equipo" },
  { pool: "libros", pick: "un paquete de libros" },
  { pool: "frutas", pick: "una ensalada" },
];

/** Permutations, combinations, anagrams, circular orders and committees (10th-11th). */
export const combinatorics: Family = {
  id: "combinatorics",
  solve(problem: Record<string, unknown>): Rational {
    const n = Number(problem.n);
    const k = Number(problem.k);
    const a = Number(problem.a);
    const b = Number(problem.b);
    const j = Number(problem.j);
    switch (problem.variant as Variant) {
      case "permutation":
        return Rational.of(falling(n, k));
      case "combination":
        return Rational.of(choose(n, k));
      case "anagram": {
        const repeats = (problem.repeats as unknown[]).map(Number);
        return Rational.of(repeats.reduce((total, r) => total / factorial(r), factorial(n)));
      }
      case "circular":
        return Rational.of(factorial(n - 1));
      case "mixed-committee":
        return Rational.of(choose(a, k) * choose(b, j));
      case "at-least-one":
        // Every committee of k from a + b, minus the ones with no member of the b group.
        return Rational.of(choose(a + b, k) - choose(a, k));
      default:
        return Rational.of(choose(n, 2) - (problem.polygon === true ? n : 0));
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["permutation", "combination"],
        ["permutation", "combination", "anagram", "handshakes"],
        ["anagram", "circular", "mixed-committee", "combination"],
        ["mixed-committee", "at-least-one", "circular", "handshakes"],
      ]),
    );
    const family = "combinatorics";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const top = Math.min(12, calibration.coefficientRange[1]);

    if (variant === "permutation") {
      const context = rng.pick(ROLES);
      const n = rng.int(context.k + 2, Math.max(context.k + 3, top));
      const k = context.k;
      const answer = falling(n, k);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Entre $${n}$ ${context.group} se eligen ${context.roles}. ¿De cuántas maneras distintas se puede hacer, si nadie ocupa dos lugares?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(choose(n, k), "ignored-the-order"),
          numberChoice(n ** k, "allowed-repetition"),
          numberChoice(n * k, "multiplied-n-by-k"),
          numberChoice(factorial(n), "ordered-everyone"),
        ],
        pool: [
          "El orden importa (cada lugar es distinto): es una permutación.",
          `$P(n, k) = \\dfrac{n!}{(n-k)!}$ con $n = ${n}$ y $k = ${k}$.`,
          `$P(${n}, ${k}) = ${Array.from({ length: k }, (_, i) => n - i).join(" \\cdot ")}$`,
          `$= ${thousands(answer)}$`,
          "El número de maneras es:",
          math(answer),
        ],
        numericValues: [n, k],
        problem: { variant, n, k },
      });
    }

    if (variant === "combination") {
      const context = rng.pick(GROUPS);
      const n = rng.int(5, Math.max(6, top));
      const k = rng.int(2, Math.min(4, n - 2));
      const answer = choose(n, k);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `De $${n}$ ${context.pool} se escogen $${k}$ para formar ${context.pick}. ¿Cuántas selecciones distintas hay, si el orden no importa?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(falling(n, k), "counted-the-order"),
          numberChoice(
            choose(n, k - 1) === answer ? answer + n : choose(n, k - 1),
            "used-k-minus-one",
          ),
          numberChoice(n * k, "multiplied-n-by-k"),
          numberChoice(falling(n, k) / k, "divided-by-k-not-k-factorial"),
        ],
        pool: [
          "El orden no importa: es una combinación.",
          `$C(n, k) = \\dfrac{n!}{k!\\,(n-k)!}$ con $n = ${n}$ y $k = ${k}$.`,
          `$C(${n}, ${k}) = \\dfrac{${Array.from({ length: k }, (_, i) => n - i).join(" \\cdot ")}}{${k}!}$`,
          `$= \\dfrac{${thousands(falling(n, k))}}{${factorial(k)}}$`,
          "El número de selecciones es:",
          math(answer),
        ],
        numericValues: [n, k],
        problem: { variant, n, k },
      });
    }

    if (variant === "anagram") {
      const { word, repeats } = rng.pick(WORDS);
      const n = word.length;
      const answer = repeats.reduce((total, r) => total / factorial(r), factorial(n));
      const divisor = repeats.reduce((total, r) => total * factorial(r), 1);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `¿Cuántas ordenaciones distintas (con o sin sentido) se pueden formar con todas las letras de la palabra ${word}?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(factorial(n), "ignored-the-repeated-letters"),
          numberChoice(
            factorial(n) / repeats.reduce((total, r) => total * r, 1),
            "divided-by-the-counts-not-factorials",
          ),
          numberChoice(
            factorial(n) / repeats.reduce((total, r) => total + r, 0),
            "divided-by-the-sum",
          ),
          numberChoice(
            factorial(n - repeats.reduce((total, r) => total + r - 1, 0)),
            "removed-the-repeated-letters",
          ),
        ],
        pool: [
          `La palabra tiene $${n}$ letras; ${repeats.length === 1 ? "una se repite" : "algunas se repiten"}.`,
          "Permutaciones con repetición: $\\dfrac{n!}{a!\\,b!\\cdots}$.",
          `$\\dfrac{${n}!}{${repeats.map((r) => `${r}!`).join("\\,")}} = \\dfrac{${thousands(factorial(n))}}{${divisor}}$`,
          "El número de ordenaciones es:",
          math(answer),
        ],
        numericValues: [n],
        problem: { variant, n, repeats },
      });
    }

    if (variant === "circular") {
      const n = rng.int(4, Math.min(8, Math.max(5, top)));
      const answer = factorial(n - 1);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `¿De cuántas maneras distintas se pueden sentar $${n}$ personas alrededor de una mesa redonda? (Dos arreglos que solo difieren por un giro cuentan como uno.)`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(factorial(n), "counted-rotations-as-different"),
          numberChoice(factorial(n - 1) / 2, "also-identified-reflections"),
          numberChoice(factorial(n - 2), "fixed-two-people"),
        ],
        pool: [
          "En una mesa redonda los giros no cambian el arreglo.",
          "Fija a una persona y ordena a las demás.",
          `$(n - 1)! = ${n - 1}!$`,
          `$= ${thousands(answer)}$`,
          "El número de arreglos es:",
          math(answer),
        ],
        numericValues: [n],
        problem: { variant, n },
      });
    }

    if (variant === "handshakes") {
      const polygon = index >= 3 || rng.int(0, 1) === 0;
      const n = rng.int(polygon ? 5 : 4, Math.max(polygon ? 6 : 5, top));
      const answer = choose(n, 2) - (polygon ? n : 0);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            polygon
              ? `¿Cuántas diagonales tiene un polígono convexo de $${n}$ lados?`
              : `En una reunión hay $${n}$ personas y cada una saluda de mano una vez a cada una de las demás. ¿Cuántos saludos hay?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: polygon
          ? [
              numberChoice(choose(n, 2), "counted-the-sides"),
              numberChoice(n * (n - 3), "counted-each-diagonal-twice"),
              numberChoice(n - 3, "counted-from-one-vertex"),
            ]
          : [
              numberChoice(n * (n - 1), "counted-each-handshake-twice"),
              numberChoice(n * n, "squared-n"),
              numberChoice(n - 1, "counted-one-person"),
            ],
        pool: polygon
          ? [
              "Cada par de vértices define un segmento: $C(n, 2)$.",
              "De esos segmentos, $n$ son lados del polígono.",
              `$C(${n}, 2) - ${n} = ${choose(n, 2)} - ${n}$`,
              "El número de diagonales es:",
              math(answer),
            ]
          : [
              "Cada saludo es un par de personas, sin orden.",
              `$C(${n}, 2) = \\dfrac{${n} \\cdot ${n - 1}}{2}$`,
              "El número de saludos es:",
              math(answer),
            ],
        numericValues: [n],
        problem: { variant, n, polygon },
      });
    }

    // mixed-committee and at-least-one: a groups of a men (A) and b women (B).
    const a = rng.int(4, Math.max(5, Math.min(9, top)));
    const b = rng.int(3, Math.max(4, Math.min(8, top)));
    if (variant === "at-least-one") {
      const k = rng.int(2, 4);
      const all = choose(a + b, k);
      const none = choose(a, k);
      const answer = all - none;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Un grupo tiene $${a}$ hombres y $${b}$ mujeres. ¿Cuántos comités de $${k}$ personas tienen al menos una mujer?`,
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(all, "ignored-the-condition"),
          numberChoice(b * choose(a + b - 1, k - 1), "overcounted-with-a-fixed-woman"),
          numberChoice(choose(b, k) || b, "required-only-women"),
          numberChoice(none, "counted-the-complement"),
        ],
        pool: [
          "Cuenta por complemento: todos los comités menos los que no tienen mujeres.",
          `Todos: $C(${a + b}, ${k}) = ${thousands(all)}$.`,
          `Sin mujeres (solo hombres): $C(${a}, ${k}) = ${thousands(none)}$.`,
          `$${thousands(all)} - ${thousands(none)} = ${thousands(answer)}$`,
          "El número de comités es:",
          math(answer),
        ],
        numericValues: [a, b, k],
        problem: { variant, a, b, k, j: 0 },
      });
    }
    const k = rng.int(1, 3);
    const j = rng.int(1, 2);
    const answer = choose(a, k) * choose(b, j);
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        ask(
          `Un club tiene $${a}$ hombres y $${b}$ mujeres. ¿De cuántas maneras se puede formar un comité con $${k}$ ${k === 1 ? "hombre" : "hombres"} y $${j}$ ${j === 1 ? "mujer" : "mujeres"}?`,
        ),
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(choose(a, k) + choose(b, j), "added-instead-of-multiplying"),
        numberChoice(choose(a + b, k + j), "ignored-the-groups"),
        numberChoice(falling(a, k) * falling(b, j), "counted-the-order"),
      ],
      pool: [
        "Se eligen los hombres y las mujeres por separado y se multiplica.",
        `Hombres: $C(${a}, ${k}) = ${choose(a, k)}$.`,
        `Mujeres: $C(${b}, ${j}) = ${choose(b, j)}$.`,
        `$${choose(a, k)} \\cdot ${choose(b, j)} = ${thousands(answer)}$`,
        "El número de comités es:",
        math(answer),
      ],
      numericValues: [a, b, k, j],
      problem: { variant, a, b, k, j },
    });
  },
};
