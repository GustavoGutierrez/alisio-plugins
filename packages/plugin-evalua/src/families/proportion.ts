import { Rational } from "../math/rational.js";
import { finishDraft, levelIndex, math, numberChoice, tier } from "./kit.js";
import { assembleOptions } from "./options.js";
import { money, perturb, pooled, positiveValue, prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "equation" | "ratio-split" | "direct" | "inverse";

interface Problem {
  a: number;
  b: number;
  c: number;
  variant?: Variant;
}

const SPLITS = [
  { whole: "dulces", who: ["Ana", "Luis"] },
  { whole: "láminas", who: ["Sofía", "Tomás"] },
  { whole: "pesos de un premio", who: ["Camila", "Mateo"] },
];

const DIRECT = [
  { item: "cuadernos", cost: "cuestan", unit: "pesos" },
  { item: "kilos de arroz", cost: "cuestan", unit: "pesos" },
  { item: "litros de pintura", cost: "cubren", unit: "metros cuadrados" },
];

const INVERSE = [
  { who: "obreros", task: "construyen un muro", time: "días" },
  { who: "grifos iguales", task: "llenan un tanque", time: "horas" },
  { who: "máquinas iguales", task: "terminan un pedido", time: "horas" },
];

/**
 * Ratios and proportions (merged from the ratio-proportion topic): the classic `a/b = x/c`
 * equation, sharing in a ratio, and direct and inverse proportion word problems (DBA 6-7).
 * Without a variant in `problem` the solver reads the original equation form.
 */
export const proportion: Family = {
  id: "proportion",
  solve(problem: Record<string, unknown>): Rational {
    const a = Number(problem.a);
    const b = Number(problem.b);
    const c = Number(problem.c);
    switch (problem.variant as Variant | undefined) {
      case "ratio-split":
        // c shared in the ratio a : b; the first part.
        return Rational.of(a * c, a + b);
      case "inverse":
        return Rational.of(a * b, c);
      default:
        // equation a/b = x/c and direct proportion (a items -> b, so c items -> b·c/a) share it.
        return problem.variant === "direct" ? Rational.of(b * c, a) : Rational.of(a * c, b);
    }
  },
  generate(context: FamilyContext): ItemDraft {
    const { rng, level, calibration, prompts } = context;
    const variant = rng.pick(
      tier<Variant>(levelIndex(level), [
        ["equation", "ratio-split"],
        ["equation", "ratio-split", "direct"],
        ["ratio-split", "direct", "inverse"],
        ["direct", "inverse", "equation"],
      ]),
    );
    if (variant === "equation") return equation(context);
    const family = "proportion";

    if (variant === "ratio-split") {
      const story = rng.pick(SPLITS);
      const a = rng.int(1, 5);
      let b = rng.int(1, 5);
      if (b === a) b = a === 5 ? 4 : a + 1;
      const unit = rng.int(2, 12);
      const total = (a + b) * unit;
      const answer = a * unit;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `${story.who[0]} y ${story.who[1]} se reparten $${total}$ ${story.whole} en la razón $${a}:${b}$. ¿Cuántos le tocan a ${story.who[0]}?`,
            "",
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(b * unit, "swapped-the-parts"),
          numberChoice(Rational.of(total, 2), "split-in-halves"),
          numberChoice(Rational.of(total, a), "divided-by-one-part"),
        ],
        pool: [
          `La razón $${a}:${b}$ divide el total en $${a} + ${b} = ${a + b}$ partes iguales.`,
          `Cada parte vale $${total} \\div ${a + b} = ${unit}$.`,
          `A ${story.who[0]} le tocan $${a}$ partes: $${a} \\times ${unit}$.`,
          "Le tocan:",
          math(answer),
        ],
        numericValues: [a, b],
        problem: { variant, a, b, c: total },
      });
    }

    if (variant === "direct") {
      const story = rng.pick(DIRECT);
      const a = rng.int(2, 6);
      const per = rng.int(2, 9) * (story.unit === "pesos" ? 500 : 1);
      const b = a * per;
      let c = rng.int(2, 12);
      if (c === a) c += 1;
      const answer = c * per;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `Si $${a}$ ${story.item} ${story.cost} $${b}$ ${story.unit}, ¿cuántos ${story.unit} ${story.cost} $${c}$ ${story.item}?`,
            "",
          ),
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(Rational.of(a * b, c), "used-inverse-proportion"),
          numberChoice(b + (c - a), "added-the-difference"),
          numberChoice(b * c, "forgot-to-divide"),
        ],
        pool: [
          "Es una proporción directa: el doble de cantidad, el doble de valor.",
          `Valor de uno: $${b} \\div ${a} = ${per}$.`,
          `Valor de $${c}$: $${c} \\times ${per}$.`,
          "El resultado es:",
          math(answer),
        ],
        numericValues: [a, c],
        problem: { variant, a, b, c },
      });
    }

    const story = rng.pick(INVERSE);
    const c = rng.int(2, 8);
    let a = rng.int(2, 8);
    if (a === c) a += 1;
    const answer = rng.int(2, 9);
    // a workers take b units; c workers take a·b / c = answer, so b = answer·c / a must be whole.
    const b = (answer * c) / a;
    const whole = Number.isInteger(b) ? b : answer * c;
    const workers = Number.isInteger(b) ? a : 1;
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [
        prompt(
          rng,
          prompts,
          `$${workers}$ ${story.who} ${story.task} en $${whole}$ ${story.time}. ¿Cuántos ${story.time} tardan $${c}$ ${story.who}, trabajando al mismo ritmo?`,
          "",
        ),
      ],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(Rational.of(whole * c, workers), "used-direct-proportion"),
        numberChoice(Math.abs(whole - (c - workers)) || whole + 1, "subtracted-the-difference"),
        numberChoice(whole * workers * c, "multiplied-everything"),
      ],
      pool: [
        "Es una proporción inversa: más trabajadores, menos tiempo.",
        `El trabajo total es $${workers} \\times ${whole} = ${workers * whole}$.`,
        `Con $${c}$: $${workers * whole} \\div ${c}$.`,
        "Tardan:",
        math(answer),
      ],
      numericValues: [workers, c],
      problem: { variant, a: workers, b: whole, c },
    });
  },
};

/** The original `a/b = x/c` item, unchanged. */
function equation({ rng, level, calibration }: FamilyContext): ItemDraft {
  const a = positiveValue(rng, calibration.coefficientRange);
  const b = positiveValue(rng, calibration.coefficientRange);
  const c = positiveValue(rng, calibration.coefficientRange);
  const answer = Rational.of(a * c, b);
  const pool = [
    `La proporción es $\\dfrac{${a}}{${b}} = \\dfrac{x}{${c}}$.`,
    `Multiplica en cruz: $${a} \\cdot ${c} = ${b} \\cdot x$.`,
    `$${a * c} = ${b} x$`,
    `Divide ambos lados entre ${b}.`,
    `$x = \\dfrac{${a * c}}{${b}}$`,
    `Simplifica la fracción.`,
    `Comprueba que las dos razones sean iguales.`,
    `$${answer.toString()}$`,
  ];
  const solution = pooled(pool, rng, calibration);
  const options = assembleOptions(
    rng,
    { value: answer.toString(), display: money(answer), error: "none" },
    [
      {
        value: Rational.of(b * c, a).toString(),
        display: money(Rational.of(b * c, a)),
        error: "inverted-ratio",
      },
      {
        value: Rational.of(a * b, c).toString(),
        display: money(Rational.of(a * b, c)),
        error: "multiplied-wrong-pair",
      },
      {
        value: Rational.of(a + c).toString(),
        display: money(Rational.of(a + c)),
        error: "added-instead",
      },
      ...perturb(answer),
    ],
  );
  return {
    family: "proportion",
    level,
    type: "single_choice",
    stem: [`Halla el valor de $x$ en la proporción: $\\dfrac{${a}}{${b}} = \\dfrac{x}{${c}}$`],
    options,
    answer: { canonical: answer.toString(), display: money(answer) },
    solution,
    numericValues: [a, b, c],
    stepCount: solution.length,
    problem: { a, b, c, variant: "equation" } satisfies Problem,
  };
}
