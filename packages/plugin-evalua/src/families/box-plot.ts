import type { FigureSpec } from "../figures/index.js";
import { latexRational } from "../math/latex.js";
import { Rational } from "../math/rational.js";
import { ascending, fiveNumbers, median } from "../math/stats.js";
import { decimalChoice, decimalMath } from "./exact.js";
import { distinctInts, finishDraft, levelIndex, numberChoice, textChoice, tier } from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "quartile" | "iqr" | "read-plot" | "share";
type Measure = "q1" | "q3" | "median" | "iqr" | "range";

const MEASURE_NAME: Record<Measure, string> = {
  q1: "el primer cuartil ($Q_1$)",
  q3: "el tercer cuartil ($Q_3$)",
  median: "la mediana",
  iqr: "el rango intercuartílico ($Q_3 - Q_1$)",
  range: "el rango",
};

function measureOf(data: readonly number[], measure: Measure): Rational {
  const five = fiveNumbers(data);
  switch (measure) {
    case "q1":
      return five.q1;
    case "q3":
      return five.q3;
    case "median":
      return five.median;
    case "iqr":
      return five.q3.sub(five.q1);
    default:
      return five.max.sub(five.min);
  }
}

/** Quartiles with the halves that keep the median (the inclusive rule), a common slip. */
function inclusiveQuartiles(data: readonly number[]): { q1: Rational; q3: Rational } {
  const ordered = ascending(data);
  const half = Math.ceil(ordered.length / 2);
  return { q1: median(ordered.slice(0, half)), q3: median(ordered.slice(ordered.length - half)) };
}

/** True when the value has a finite decimal expansion (denominator made of 2s and 5s). */
export function terminates(value: Rational): boolean {
  let d = value.d;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  return d === 1n;
}

const asNumber = (value: Rational): number => Number(value.n) / Number(value.d);

/** Quartiles, interquartile range and reading a box plot (merged into statistics, grades 8-9). */
export const boxPlot: Family = {
  id: "box-plot",
  solve(problem: Record<string, unknown>): Rational | string {
    const data = (problem.data as unknown[]).map(Number);
    if (problem.variant === "share") return String(problem.share);
    return measureOf(data, problem.measure as Measure);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variant = rng.pick(
      tier<Variant>(index, [
        ["quartile"],
        ["quartile", "read-plot"],
        ["quartile", "iqr", "read-plot"],
        ["iqr", "read-plot", "share"],
      ]),
    );
    const family = "box-plot";
    const high = Math.max(9, Math.min(60, Math.floor(calibration.coefficientRange[1])));
    const size = rng.pick(index >= 2 ? [7, 8, 9, 10, 11] : [7, 8, 9]);
    const data = distinctInts(rng, size, 1, high).sort((a, b) => a - b);
    const five = fiveNumbers(data);
    const listing = `$${rng.shuffle(data).join(",\\ ")}$`;
    const step = high > 30 ? 5 : 2;
    const figure: FigureSpec = {
      kind: "box-plot",
      params: {
        min: asNumber(five.min),
        q1: asNumber(five.q1),
        median: asNumber(five.median),
        q3: asNumber(five.q3),
        max: asNumber(five.max),
        axisMin: 0,
        axisMax: Math.ceil(asNumber(five.max) / step) * step,
        step,
        ...(variant === "read-plot" ? { showValues: true } : {}),
      },
    };
    const ordered = `Datos ordenados: $${data.join(",\\ ")}$.`;

    if (variant === "share") {
      const shares = [
        { text: "mayores que $Q_3$", value: "25" },
        { text: "entre $Q_1$ y $Q_3$", value: "50" },
        { text: "menores que $Q_3$", value: "75" },
        { text: "menores que la mediana", value: "50" },
      ];
      const asked = rng.pick(shares);
      const choice = (value: string, error: string): OptionCandidate =>
        textChoice(value, error, `$${value}\\%$`);
      const wrong = ["25", "50", "75", "100"].filter((value) => value !== asked.value);
      return finishDraft({
        family,
        level,
        rng,
        calibration,
        stem: [
          prompt(
            rng,
            prompts,
            `Según el diagrama de caja, ¿qué porcentaje aproximado de los datos es ${asked.text}?`,
            "",
          ),
          { figure },
        ],
        correct: choice(asked.value, "none"),
        distractors: wrong.map((value) => choice(value, "misread-the-quarters")),
        pool: [
          "Los cuartiles dividen los datos ordenados en cuatro partes con el mismo número de datos.",
          "Cada parte tiene cerca del $25\\%$ de los datos.",
          `Los datos ${asked.text} ocupan ${asked.value === "25" ? "una parte" : asked.value === "50" ? "dos partes" : "tres partes"}.`,
          "El porcentaje es:",
          `$${asked.value}\\%$`,
        ],
        numericValues: [],
        problem: { variant, data, share: asked.value },
        fallback: "none",
      });
    }

    const measure: Measure =
      variant === "iqr"
        ? "iqr"
        : variant === "read-plot"
          ? rng.pick<Measure>(["median", "iqr", "range", "q1"])
          : rng.pick<Measure>(["q1", "q3", "median"]);
    const answer = measureOf(data, measure);
    const inclusive = inclusiveQuartiles(data);
    const candidates: OptionCandidate[] = [];
    const add = (value: Rational, error: string) =>
      candidates.push(terminates(value) ? decimalChoice(value, error) : numberChoice(value, error));
    if (measure === "q1") {
      add(five.q3, "swapped-the-quartiles");
      add(inclusive.q1, "kept-the-median-in-the-half");
      add(five.median, "gave-the-median");
      add(Rational.of(data[1] ?? 0), "counted-a-quarter-of-the-data");
    } else if (measure === "q3") {
      add(five.q1, "swapped-the-quartiles");
      add(inclusive.q3, "kept-the-median-in-the-half");
      add(five.median, "gave-the-median");
      add(Rational.of(data[data.length - 2] ?? 0), "counted-a-quarter-of-the-data");
    } else if (measure === "median") {
      add(five.q1, "gave-a-quartile");
      add(five.q3, "gave-a-quartile");
      add(
        Rational.of(
          data.reduce((sum, value) => sum + value, 0),
          data.length,
        ),
        "gave-the-mean",
      );
      add(five.min.add(five.max).div(Rational.of(2)), "averaged-the-extremes");
    } else if (measure === "iqr") {
      add(five.max.sub(five.min), "gave-the-range");
      add(inclusive.q3.sub(inclusive.q1), "kept-the-median-in-the-half");
      add(five.q3.add(five.q1).div(Rational.of(2)), "averaged-the-quartiles");
      add(five.q3, "gave-the-third-quartile");
    } else {
      add(five.q3.sub(five.q1), "gave-the-interquartile-range");
      add(five.max, "gave-the-maximum");
      add(five.max.add(five.min), "added-the-extremes");
    }
    const fromPlot = variant === "read-plot";
    return finishDraft({
      family,
      level,
      rng,
      calibration,
      stem: fromPlot
        ? [
            prompt(
              rng,
              prompts,
              `Observa el diagrama de caja. ¿Cuál es ${MEASURE_NAME[measure]}?`,
              "",
            ),
            { figure },
          ]
        : [prompt(rng, prompts, `Calcula ${MEASURE_NAME[measure]} de los datos: {expr}`, listing)],
      correct: decimalChoice(answer, "none"),
      distractors: candidates,
      pool: [
        fromPlot
          ? "En el diagrama: los extremos son el mínimo y el máximo; la caja va de $Q_1$ a $Q_3$."
          : ordered,
        `La mediana es $${latexRational(five.median)}$ y divide los datos en dos mitades.`,
        "$Q_1$ es la mediana de la mitad inferior y $Q_3$ la de la mitad superior (sin la mediana si el número de datos es impar).",
        `$Q_1 = ${decimalMath(five.q1).slice(1, -1)}$, $Q_3 = ${decimalMath(five.q3).slice(1, -1)}$`,
        "El resultado es:",
        decimalMath(answer),
      ],
      numericValues: [asNumber(five.min), asNumber(five.max)],
      problem: { variant, data, measure },
      fallback: "any",
    });
  },
};
