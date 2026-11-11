import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import { finishDraft, fractionMath, levelIndex, math, numberChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "count" | "both" | "coins" | "two-draws";

/** One stage of a compound experiment: its equally likely outcomes and how to describe them. */
interface Stage {
  id: string;
  outcomes: string[];
  text: string;
}

const STAGES: Record<string, Stage> = {
  coin: { id: "coin", outcomes: ["C", "S"], text: "se lanza una moneda (C = cara, S = sello)" },
  die: { id: "die", outcomes: ["1", "2", "3", "4", "5", "6"], text: "se lanza un dado" },
  spinner3: {
    id: "spinner3",
    outcomes: ["A", "B", "C"],
    text: "se gira una ruleta con 3 sectores iguales A, B y C",
  },
  spinner4: {
    id: "spinner4",
    outcomes: ["1", "2", "3", "4"],
    text: "se gira una ruleta con 4 sectores iguales numerados del 1 al 4",
  },
  bag: {
    id: "bag",
    outcomes: ["R", "V"],
    text: "se saca una ficha de una bolsa con una roja (R) y una verde (V)",
  },
};

/** Events on one stage: the favourable outcomes and how the question names them. */
const EVENTS: Record<string, Array<{ name: string; favourable: string[] }>> = {
  coin: [
    { name: "cara", favourable: ["C"] },
    { name: "sello", favourable: ["S"] },
  ],
  die: [
    { name: "un número par", favourable: ["2", "4", "6"] },
    { name: "un $6$", favourable: ["6"] },
    { name: "un número mayor que $4$", favourable: ["5", "6"] },
    { name: "un número menor que $3$", favourable: ["1", "2"] },
  ],
  spinner3: [
    { name: "A", favourable: ["A"] },
    { name: "A o B", favourable: ["A", "B"] },
  ],
  spinner4: [
    { name: "un número impar", favourable: ["1", "3"] },
    { name: "el $4$", favourable: ["4"] },
    { name: "un número mayor que $1$", favourable: ["2", "3", "4"] },
  ],
  bag: [{ name: "roja", favourable: ["R"] }],
};

const PAIRS: ReadonlyArray<[string, string]> = [
  ["coin", "die"],
  ["coin", "spinner3"],
  ["coin", "spinner4"],
  ["die", "coin"],
  ["spinner3", "spinner4"],
  ["spinner4", "spinner3"],
  ["coin", "coin"],
  ["spinner3", "coin"],
  ["bag", "spinner3"],
  ["die", "spinner3"],
];

/** Everyday "choose one of each" situations for counting outcomes with a tree. */
const MENUS = [
  {
    first: "camisetas",
    second: "pantalones",
    a: "K",
    b: "P",
    text: "Ana tiene {n} camisetas y {m} pantalones. Escoge una camiseta y un pantalón.",
  },
  {
    first: "sopas",
    second: "jugos",
    a: "S",
    b: "J",
    text: "Un menú ofrece {n} sopas y {m} jugos. Se escoge una sopa y un jugo.",
  },
  {
    first: "sabores",
    second: "salsas",
    a: "H",
    b: "T",
    text: "Una heladería tiene {n} sabores y {m} salsas. Se pide un sabor con una salsa.",
  },
] as const;

const choose = (n: number, k: number): number => {
  let out = 1;
  for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
};

/** Sample spaces with tree diagrams and the probability of compound events (DBA 6 #12, 7 #9). */
export const compoundProbability: Family = {
  id: "compound-probability",
  solve(problem: Record<string, unknown>): Rational {
    switch (problem.variant as Variant) {
      case "count":
        return Rational.of(
          (problem.sizes as number[]).reduce((product, size) => product * size, 1),
        );
      case "both": {
        const [s1, s2] = problem.sizes as number[];
        const [f1, f2] = problem.favourable as number[];
        return Rational.of((f1 ?? 0) * (f2 ?? 0), (s1 ?? 1) * (s2 ?? 1));
      }
      case "coins": {
        const coins = Number(problem.coins);
        const total = 2 ** coins;
        if (problem.event === "at-least-one") return Rational.of(total - 1, total);
        return Rational.of(choose(coins, Number(problem.heads)), total);
      }
      default: {
        const red = Number(problem.red);
        const total = red + Number(problem.blue);
        return problem.replace === true
          ? Rational.of(red * red, total * total)
          : Rational.of(red * (red - 1), total * (total - 1));
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["count"],
        ["count", "both"],
        ["both", "coins"],
        ["coins", "two-draws", "both"],
      ]),
    );
    const family = "compound-probability";

    if (variant === "count" && rng.int(0, 1) === 0) {
      const menu = rng.pick(MENUS);
      const n = rng.int(2, 5);
      const m = rng.int(2, 5);
      const total = n * m;
      const tree: FigureSpec = {
        kind: "tree-diagram",
        params: {
          stages: [
            Array.from({ length: n }, (_, i) => `${menu.a}${i + 1}`),
            Array.from({ length: m }, (_, i) => `${menu.b}${i + 1}`),
          ],
          leafLabels: total <= 12,
        },
      };
      const story = menu.text.replace("{n}", `$${n}$`).replace("{m}", `$${m}$`);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(rng, prompts, `${story} ¿Cuántas combinaciones distintas hay?`, ""),
          ...(total <= 16 ? [{ figure: tree }] : []),
        ],
        correct: numberChoice(total, "none"),
        distractors: [
          numberChoice(n + m, "added-instead"),
          numberChoice(Math.max(n, m), "counted-one-stage"),
          numberChoice(total + Math.min(n, m), "counted-the-nodes"),
        ],
        pool: [
          `Cada una de las $${n}$ ${menu.first} se combina con cada uno de los $${m}$ ${menu.second}.`,
          "Principio multiplicativo: se multiplican las opciones de cada etapa.",
          `$${n} \\times ${m} = ${total}$`,
          "El número de combinaciones es:",
          math(total),
        ],
        numericValues: [n, m],
        problem: { variant, sizes: [n, m] },
      });
    }

    if (variant === "count" || variant === "both") {
      const [firstId, secondId] = rng.pick(PAIRS);
      const first = STAGES[firstId] as Stage;
      const second = STAGES[secondId] as Stage;
      const sizes = [first.outcomes.length, second.outcomes.length];
      const total = (sizes[0] ?? 1) * (sizes[1] ?? 1);
      const tree: FigureSpec = {
        kind: "tree-diagram",
        params: { stages: [first.outcomes, second.outcomes], leafLabels: total <= 12 },
      };
      const setup = `Primero ${first.text} y luego ${second.text}.`;
      if (variant === "count") {
        return finishDraft({
          family,
          level,
          rng,
          calibration,
          stem: [
            prompt(rng, prompts, `${setup} ¿Cuántos resultados posibles tiene el experimento?`, ""),
            ...(total <= 16 ? [{ figure: tree }] : []),
          ],
          correct: numberChoice(total, "none"),
          distractors: [
            numberChoice((sizes[0] ?? 0) + (sizes[1] ?? 0), "added-instead"),
            numberChoice(Math.max(...sizes), "counted-one-stage"),
            numberChoice(total - 1, "missed-a-branch"),
          ],
          pool: [
            "Cada resultado de la primera etapa se combina con cada resultado de la segunda.",
            `Primera etapa: $${sizes[0]}$ resultados. Segunda etapa: $${sizes[1]}$ resultados.`,
            `$${sizes[0]} \\times ${sizes[1]} = ${total}$`,
            "Las ramas finales del diagrama de árbol son:",
            math(total),
          ],
          numericValues: sizes,
          problem: { variant, sizes },
        });
      }
      const event1 = rng.pick(EVENTS[firstId] ?? []);
      const event2 = rng.pick(EVENTS[secondId] ?? []);
      const favourable = [event1?.favourable.length ?? 1, event2?.favourable.length ?? 1];
      const [f1, f2] = favourable as [number, number];
      const answer = Rational.of(f1 * f2, total);
      const p1 = Rational.of(f1, sizes[0] ?? 1);
      const p2 = Rational.of(f2, sizes[1] ?? 1);
      const candidates: OptionCandidate[] = [
        numberChoice(
          p1.add(p2).compare(Rational.one) <= 0 ? p1.add(p2) : Rational.of(f1 + f2, total),
          "added-the-probabilities",
        ),
        numberChoice(
          Rational.of(f1 * f2, (sizes[0] ?? 1) + (sizes[1] ?? 1)),
          "added-the-sample-spaces",
        ),
        numberChoice(p1, "ignored-the-second-stage"),
        numberChoice(p2, "ignored-the-first-stage"),
        numberChoice(Rational.of(f1 + f2, total), "added-the-favourable-cases"),
        numberChoice(Rational.one.sub(answer), "found-the-complement"),
        numberChoice(
          Rational.of(1, total).equals(answer) ? Rational.of(2, total) : Rational.of(1, total),
          "one-outcome-only",
        ),
      ];
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `${setup} ¿Cuál es la probabilidad de obtener ${event1?.name ?? ""} y ${event2?.name ?? ""}?`,
            "",
          ),
          ...(total <= 16 ? [{ figure: tree }] : []),
        ],
        correct: numberChoice(answer, "none"),
        distractors: candidates,
        pool: [
          `El experimento tiene $${sizes[0]} \\times ${sizes[1]} = ${total}$ resultados igualmente probables.`,
          `Casos favorables: $${f1} \\times ${f2} = ${f1 * f2}$.`,
          `$P = ${math(answer).slice(1, -1)}$`,
          `También: $${math(p1).slice(1, -1)} \\times ${math(p2).slice(1, -1)} = ${math(answer).slice(1, -1)}$`,
          "La probabilidad es:",
          math(answer),
        ],
        numericValues: [...sizes, f1, f2],
        problem: { variant, sizes, favourable },
        fallback: "none",
      });
    }

    if (variant === "coins") {
      const coins = rng.int(2, 3);
      const total = 2 ** coins;
      const event = rng.pick(["at-least-one", "exactly"] as const);
      const heads = event === "exactly" ? rng.int(1, coins - 1 || 1) : 1;
      const favourable = event === "at-least-one" ? total - 1 : choose(coins, heads);
      const answer = Rational.of(favourable, total);
      const tree: FigureSpec = {
        kind: "tree-diagram",
        params: { stages: Array.from({ length: coins }, () => ["C", "S"]), leafLabels: true },
      };
      const asked =
        event === "at-least-one"
          ? "al menos una cara"
          : `exactamente $${heads}$ ${heads === 1 ? "cara" : "caras"}`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `Se lanzan $${coins}$ monedas. ¿Cuál es la probabilidad de obtener ${asked}?`,
            "",
          ),
          { figure: tree },
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(1, total), "one-outcome-only"),
          numberChoice(Rational.of(total - favourable, total), "found-the-complement"),
          numberChoice(
            Rational.of(event === "at-least-one" ? 1 : heads, coins + 1),
            "counted-head-totals-as-equally-likely",
          ),
          numberChoice(Rational.of(1, 2), "assumed-one-half"),
          numberChoice(
            Rational.of(event === "at-least-one" ? coins : total - 1, total),
            event === "at-least-one" ? "counted-exactly-one" : "counted-at-least-one",
          ),
        ],
        pool: [
          `Hay $2^{${coins}} = ${total}$ resultados igualmente probables.`,
          event === "at-least-one"
            ? "El único resultado sin caras es que todas sean sello."
            : `Cuenta las ramas con exactamente $${heads}$ ${heads === 1 ? "cara" : "caras"}.`,
          `Casos favorables: $${favourable}$.`,
          `$P = ${fractionMath(favourable, total).slice(1, -1)}$`,
          "La probabilidad es:",
          math(answer),
        ],
        numericValues: [coins],
        problem: { variant, coins, event, heads },
        fallback: "none",
      });
    }

    // Two draws from a bag, with or without putting the first ball back.
    const red = rng.int(2, 6);
    const blue = rng.int(2, 6);
    const total = red + blue;
    const replace = rng.int(0, 1) === 0;
    const withBack = Rational.of(red * red, total * total);
    const without = Rational.of(red * (red - 1), total * (total - 1));
    const answer = replace ? withBack : without;
    const second = replace
      ? [`${red}/${total}`, `${blue}/${total}`, `${red}/${total}`, `${blue}/${total}`]
      : [
          `${red - 1}/${total - 1}`,
          `${blue}/${total - 1}`,
          `${red}/${total - 1}`,
          `${blue - 1}/${total - 1}`,
        ];
    const tree: FigureSpec = {
      kind: "tree-diagram",
      params: {
        stages: [
          ["R", "A"],
          ["R", "A"],
        ],
        edgeLabels: [`${red}/${total}`, `${blue}/${total}`, ...second],
        leafLabels: true,
      },
    };
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        prompt(
          rng,
          prompts,
          `Una bolsa tiene $${red}$ bolas rojas (R) y $${blue}$ azules (A). Se sacan dos bolas ${replace ? "con reemplazo (se devuelve la primera)" : "sin reemplazo (no se devuelve la primera)"}. ¿Cuál es la probabilidad de que ambas sean rojas?`,
          "",
        ),
        { figure: tree },
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(
          replace ? without : withBack,
          replace ? "removed-the-first-ball" : "put-the-ball-back",
        ),
        numberChoice(Rational.of(red, total), "one-draw-only"),
        numberChoice(Rational.of(red * (red - 1), total * total), "kept-the-total"),
        numberChoice(
          Rational.of(2 * red, total).compare(Rational.one) < 0
            ? Rational.of(2 * red, total)
            : Rational.of(red, 2 * total),
          "added-the-draws",
        ),
      ],
      pool: [
        "Multiplica las probabilidades a lo largo de la rama R-R.",
        `Primera bola roja: $\\dfrac{${red}}{${total}}$.`,
        replace
          ? `Con reemplazo la bolsa no cambia: $\\dfrac{${red}}{${total}}$.`
          : `Sin reemplazo queda una roja menos: $\\dfrac{${red - 1}}{${total - 1}}$.`,
        replace
          ? `$\\dfrac{${red}}{${total}} \\cdot \\dfrac{${red}}{${total}}$`
          : `$\\dfrac{${red}}{${total}} \\cdot \\dfrac{${red - 1}}{${total - 1}}$`,
        "La probabilidad es:",
        math(answer),
      ],
      numericValues: [red, blue],
      problem: { variant, red, blue, replace },
      fallback: "none",
    });
  },
};
