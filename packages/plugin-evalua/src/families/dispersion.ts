import { Rational } from "../math/rational.js";
import type { Rng } from "../math/rng.js";
import { ascending, mean, variance } from "../math/stats.js";
import { surdChoice, surdMath, surdText } from "./exact.js";
import { finishDraft, levelHigh, levelIndex, math, numberChoice, tier } from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "range" | "variance" | "std-dev" | "frequency" | "transform";

const CONTEXTS = [
  "Las notas de un estudiante en sus quizzes fueron",
  "Los goles marcados por un equipo en sus últimos partidos fueron",
  "Las horas de sueño de un grupo de jóvenes fueron",
  "Las temperaturas máximas (en °C) de una semana fueron",
  "Los minutos que tardó un bus en llegar cada día fueron",
];

/** `Σ(x - x̄)²`, exact. */
export function squaredDeviations(data: readonly number[]): Rational {
  return variance(data).mul(Rational.of(data.length));
}

/**
 * A small data set whose mean and population variance are both whole numbers, so the standard
 * deviation is an exact (possibly simplified) square root. Deviations are drawn first and shifted
 * by the mean; a retry keeps their sum at zero and `Σd²` divisible by `n`.
 */
export function wholeVarianceData(
  rng: Rng,
  count: number,
  centre: number,
  spread: number,
): number[] {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const deviations = Array.from({ length: count - 1 }, () => rng.int(-spread, spread));
    const last = -deviations.reduce((sum, value) => sum + value, 0);
    if (Math.abs(last) > spread) continue;
    deviations.push(last);
    const squares = deviations.reduce((sum, value) => sum + value * value, 0);
    if (squares === 0 || squares % count !== 0) continue;
    return deviations.map((value) => centre + value);
  }
  // Deviations -2, 0, 2 and 0 for n = 4 (variance 2); padded with the centre otherwise.
  return [centre - 2, centre + 2, ...Array.from({ length: count - 2 }, () => centre)];
}

const listing = (data: readonly number[]): string =>
  data
    .map((value) => `$${value}$`)
    .join(", ")
    .replace(/, ([^,]*)$/, " y $1");

/** Range, variance and standard deviation of small data sets, exact (DBA 10 #9). */
export const dispersion: Family = {
  id: "dispersion",
  solve(problem: Record<string, unknown>): Rational | string {
    const data = (problem.data as unknown[]).map(Number);
    switch (problem.variant as Variant) {
      case "range": {
        const ordered = ascending(data);
        return Rational.of((ordered[ordered.length - 1] ?? 0) - (ordered[0] ?? 0));
      }
      case "variance":
      case "frequency":
        return variance(data);
      case "std-dev":
        return surdText(Rational.one, variance(data).toNumber());
      default: {
        // Var(kX + c) = k² Var(X); the shift c does not change the spread.
        const k = Number(problem.k);
        const value = Rational.parse(String(problem.given)).mul(Rational.of(k * k));
        return problem.ask === "std" ? surdText(Rational.one, value.toNumber()) : value;
      }
    }
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["range", "variance"],
        ["range", "variance", "std-dev"],
        ["variance", "std-dev", "frequency"],
        ["std-dev", "frequency", "transform"],
      ]),
    );
    const family = "dispersion";
    const ask = (text: string) => prompt(rng, prompts, text, "");
    const high = levelHigh(calibration, 40, 10);
    const context = rng.pick(CONTEXTS);

    if (variant === "range") {
      const count = rng.int(5, 7);
      const data = Array.from({ length: count }, () => rng.int(1, high));
      const ordered = ascending(data);
      const min = ordered[0] ?? 0;
      const max = ordered[ordered.length - 1] ?? 0;
      if (max === min) data[0] = min + 3 > high ? min - 3 : min + 3;
      const sorted = ascending(data);
      const low = sorted[0] ?? 0;
      const top = sorted[sorted.length - 1] ?? 0;
      const first = data[0] ?? 0;
      const last = data[data.length - 1] ?? 0;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [ask(`${context} ${listing(data)}. ¿Cuál es el rango de los datos?`)],
        correct: numberChoice(top - low, "none"),
        distractors: [
          numberChoice(top, "gave-the-maximum"),
          numberChoice(top + low, "added-the-extremes"),
          numberChoice(Math.abs(last - first), "used-first-and-last-unsorted"),
          numberChoice(Math.max(...sorted.slice(1)) - (sorted[1] ?? 0), "skipped-the-minimum"),
        ],
        pool: [
          "El rango mide la dispersión con los valores extremos.",
          `Ordena los datos: ${listing(sorted)}.`,
          `Máximo: $${top}$. Mínimo: $${low}$.`,
          `$${top} - ${low} = ${top - low}$`,
          "El rango es:",
          math(top - low),
        ],
        numericValues: data,
        problem: { variant, data },
        fallback: "natural",
      });
    }

    if (variant === "transform") {
      const given = rng.int(2, 9);
      const k = rng.pick([2, 3, -2, 4, 5]);
      const c = rng.int(1, 20);
      const askStd = rng.int(0, 1) === 0;
      const value = Rational.of(given * k * k);
      const answer = askStd ? surdChoice(given * k * k, "none") : numberChoice(value, "none");
      const transformText = `${k}x + ${c}`;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `Un conjunto de datos tiene varianza $${given}$. Si cada dato $x$ se transforma en $${transformText}$, ¿cuál es ${askStd ? "la desviación estándar" : "la varianza"} de los nuevos datos?`,
          ),
        ],
        correct: answer,
        distractors: askStd
          ? [
              numberChoice(value, "gave-the-variance"),
              surdChoice(given * Math.abs(k), "multiplied-the-variance-by-k"),
              surdChoice(given * k * k + c, "added-the-shift"),
              surdChoice(given, "ignored-the-factor"),
            ]
          : [
              numberChoice(given * Math.abs(k), "multiplied-by-k-not-k-squared"),
              numberChoice(given * k * k + c, "added-the-shift"),
              numberChoice(given * Math.abs(k) + c, "applied-the-transform-to-the-variance"),
              numberChoice(given, "ignored-the-factor"),
            ],
        pool: [
          "Sumar una constante desplaza los datos pero no cambia su dispersión.",
          "Multiplicar por $k$ multiplica la varianza por $k^2$.",
          `$\\text{Var} = ${k * k} \\cdot ${given} = ${given * k * k}$`,
          askStd
            ? `La desviación estándar es la raíz: $\\sqrt{${given * k * k}}$.`
            : "La varianza nueva no depende del desplazamiento.",
          askStd ? "La desviación estándar es:" : "La varianza es:",
          askStd ? surdMath(Rational.one, given * k * k) : math(value),
        ],
        numericValues: [given, Math.abs(k), c],
        problem: { variant, given: String(given), k, ask: askStd ? "std" : "var", data: [] },
        fallback: "none",
      });
    }

    if (variant === "frequency") {
      // A frequency table of small whole values with a whole mean.
      const values = [1, 2, 3, 4, 5].map((step) => step + rng.int(0, 3));
      const base = Array.from(new Set(values))
        .sort((a, b) => a - b)
        .slice(0, 4);
      let frequencies = base.map(() => rng.int(1, 4));
      let data = base.flatMap(
        (value, position) => Array(frequencies[position]).fill(value) as number[],
      );
      for (let attempt = 0; attempt < 40 && !mean(data).isInteger(); attempt += 1) {
        frequencies = base.map(() => rng.int(1, 4));
        data = base.flatMap(
          (value, position) => Array(frequencies[position]).fill(value) as number[],
        );
      }
      const average = mean(data);
      const answer = variance(data);
      const sum = squaredDeviations(data);
      const n = data.length;
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            "La tabla muestra cuántas veces se repite cada valor. ¿Cuál es la varianza (poblacional) de los datos?",
          ),
          {
            table: {
              head: ["Valor $x$", "Frecuencia $f$"],
              rows: base.map((value, position) => [`$${value}$`, `$${frequencies[position]}$`]),
            },
          },
        ],
        correct: numberChoice(answer, "none"),
        distractors: [
          numberChoice(n > 1 ? sum.div(Rational.of(n - 1)) : sum, "used-the-sample-variance"),
          numberChoice(sum, "forgot-to-divide"),
          numberChoice(variance(base), "ignored-the-frequencies"),
          numberChoice(sum.div(Rational.of(base.length)), "divided-by-the-number-of-values"),
          numberChoice(average, "gave-the-mean"),
          numberChoice((base[base.length - 1] ?? 0) - (base[0] ?? 0), "gave-the-range"),
        ],
        pool: [
          `Hay $n = ${n}$ datos en total.`,
          `La media es $\\bar{x} = ${math(average).slice(1, -1)}$.`,
          "Multiplica cada $(x - \\bar{x})^2$ por su frecuencia.",
          `$\\sum f(x - \\bar{x})^2 = ${math(sum).slice(1, -1)}$`,
          `$\\sigma^2 = \\dfrac{${math(sum).slice(1, -1)}}{${n}}$`,
          "La varianza es:",
          math(answer),
        ],
        numericValues: [...base, ...frequencies],
        problem: { variant, data },
        fallback: "any",
      });
    }

    // variance and std-dev over a short list with whole mean (and whole variance for std-dev).
    const count = rng.int(4, index >= 2 ? 6 : 5);
    const spread = Math.min(6, Math.max(2, Math.floor(high / 4)));
    // Every value stays a positive whole number inside the level range.
    const centre = rng.int(spread + 1, Math.max(spread + 2, high - spread));
    const data = wholeVarianceData(rng, count, centre, spread);
    const average = mean(data);
    const sum = squaredDeviations(data);
    const answer = variance(data);
    const deviations = data.map((value) => Rational.of(value).sub(average));
    const absolute = deviations.reduce((total, value) => total.add(value.abs()), Rational.zero);
    const pool = [
      `La media es $\\bar{x} = \\dfrac{${data.reduce((total, value) => total + value, 0)}}{${count}} = ${math(average).slice(1, -1)}$.`,
      `Desviaciones: ${deviations.map((value) => math(value)).join(", ")}.`,
      `Suma de sus cuadrados: $${math(sum).slice(1, -1)}$.`,
      `$\\sigma^2 = \\dfrac{${math(sum).slice(1, -1)}}{${count}} = ${math(answer).slice(1, -1)}$`,
    ];
    if (variant === "std-dev") {
      const whole = answer.toNumber();
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          ask(
            `${context} ${listing(data)}. ¿Cuál es la desviación estándar (poblacional) en forma exacta?`,
          ),
        ],
        correct: surdChoice(whole, "none"),
        distractors: [
          numberChoice(answer, "forgot-the-square-root"),
          surdChoice(sum.toNumber(), "forgot-to-divide"),
          numberChoice(absolute.div(Rational.of(count)), "used-the-mean-absolute-deviation"),
          numberChoice(average, "gave-the-mean"),
          surdChoice(whole + 1, "off-by-one"),
        ],
        pool: [
          ...pool,
          `$\\sigma = \\sqrt{${whole}}$`,
          "La desviación estándar es:",
          surdMath(Rational.one, whole),
        ],
        numericValues: data,
        problem: { variant, data },
        fallback: "none",
      });
    }
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: [ask(`${context} ${listing(data)}. ¿Cuál es la varianza (poblacional)?`)],
      correct: numberChoice(answer, "none"),
      distractors: [
        numberChoice(sum.div(Rational.of(count - 1)), "used-the-sample-variance"),
        numberChoice(sum, "forgot-to-divide"),
        numberChoice(absolute.div(Rational.of(count)), "used-the-mean-absolute-deviation"),
        numberChoice(answer.add(average), "added-the-mean"),
      ],
      pool: [...pool, "La varianza es:", math(answer)],
      numericValues: data,
      problem: { variant, data },
      fallback: "none",
    });
  },
};
