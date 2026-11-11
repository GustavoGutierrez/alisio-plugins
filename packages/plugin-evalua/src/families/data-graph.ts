import type { FigureSpec } from "../figures/index.js";
import type { MarkupLine } from "../markup.js";
import { Rational } from "../math/rational.js";
import {
  distinctInts,
  finishDraft,
  levelHigh,
  levelIndex,
  math,
  numberChoice,
  textChoice,
  tier,
} from "./kit.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Display = "pictogram" | "bars" | "table";
type Question = "read" | "most" | "least" | "difference" | "total";

const SURVEYS = [
  {
    title: "Fruta favorita",
    column: "Fruta",
    categories: ["Mango", "Banano", "Fresa", "Uva", "Piña"],
  },
  {
    title: "Mascota preferida",
    column: "Mascota",
    categories: ["Perro", "Gato", "Pez", "Loro", "Conejo"],
  },
  {
    title: "Deporte favorito",
    column: "Deporte",
    categories: ["Fútbol", "Baloncesto", "Natación", "Ciclismo", "Patinaje"],
  },
  {
    title: "Color preferido",
    column: "Color",
    categories: ["Azul", "Rojo", "Verde", "Amarillo", "Morado"],
  },
] as const;

interface Problem {
  question: Question;
  categories: string[];
  values: number[];
  /** The categories a question names (one for `read`, two for `difference`). */
  asked: number[];
}

function solveData(problem: Problem): Rational | string {
  const { values, asked, categories } = problem;
  if (problem.question === "most" || problem.question === "least") {
    const target = problem.question === "most" ? Math.max(...values) : Math.min(...values);
    return categories[values.indexOf(target)] ?? "";
  }
  if (problem.question === "total")
    return Rational.of(values.reduce((sum, value) => sum + value, 0));
  const first = values[asked[0] ?? 0] ?? 0;
  if (problem.question === "read") return Rational.of(first);
  return Rational.of(Math.abs(first - (values[asked[1] ?? 0] ?? 0)));
}

/** Reading pictograms, bar charts and tables of a small survey (DBA 1 #10, 2 #10). */
export const dataGraph: Family = {
  id: "data-graph",
  solve(problem: Record<string, unknown>): Rational | string {
    return solveData(problem as unknown as Problem);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const survey = rng.pick(SURVEYS);
    const count = Math.min(survey.categories.length, [4, 4, 5, 5][index] ?? 4);
    const categories = rng.shuffle([...survey.categories]).slice(0, count);
    const unit = rng.pick([[1], [1, 2], [2, 5], [2, 5, 10]][index] ?? [1]);
    const high = levelHigh(calibration, 10 * unit, 4);
    const symbols = distinctInts(
      rng,
      count,
      1,
      Math.max(count, Math.min(10, Math.floor(high / unit))),
    );
    const values = symbols.map((value) => value * unit);
    const display = rng.pick<Display>(["pictogram", "bars", "table"]);
    const questions = tier<Question>(index, [
      ["read", "most", "least"],
      ["read", "most", "difference", "total"],
      ["read", "difference", "total", "least"],
      ["difference", "total", "read"],
    ]);
    const question = rng.pick(questions);
    const [first, second] = rng.shuffle(categories.map((_, position) => position));
    const asked = question === "difference" ? [first ?? 0, second ?? 1] : [first ?? 0];
    const problem: Problem = { question, categories, values, asked };
    const answer = solveData(problem);
    const name = (position: number) => categories[position] ?? "";
    const votesOf = (position: number) => values[position] ?? 0;

    let shown: MarkupLine;
    let reading: string;
    if (display === "table") {
      shown = {
        table: {
          head: [survey.column, "Votos"],
          rows: categories.map((category, position) => [category, `$${votesOf(position)}$`]),
        },
      };
      reading = "Lee cada valor en la columna de votos.";
    } else {
      const figure: FigureSpec =
        display === "pictogram"
          ? {
              kind: "pictogram",
              label: survey.title,
              params: { labels: categories, symbols, unit },
            }
          : {
              kind: "bar-chart",
              label: survey.title,
              params: { labels: categories, values, step: unit, axis: "Votos" },
            };
      shown = { figure };
      reading =
        display === "pictogram"
          ? `Cada símbolo vale $${unit}$: multiplica los símbolos de cada fila por $${unit}$.`
          : "Lee la altura de cada barra en el eje de los votos.";
    }
    const intro =
      `La ${display === "table" ? "tabla" : display === "bars" ? "gráfica" : "pictograma"} muestra los votos de un curso sobre: ${survey.title.toLowerCase()}.`.replace(
        "La pictograma",
        "El pictograma",
      );
    const ask: Record<Question, string> = {
      read: `¿Cuántos votos tiene ${name(asked[0] ?? 0)}?`,
      most: "¿Cuál opción tiene más votos?",
      least: "¿Cuál opción tiene menos votos?",
      difference: `¿Cuántos votos más tiene ${votesOf(asked[0] ?? 0) >= votesOf(asked[1] ?? 0) ? name(asked[0] ?? 0) : name(asked[1] ?? 0)} que ${votesOf(asked[0] ?? 0) >= votesOf(asked[1] ?? 0) ? name(asked[1] ?? 0) : name(asked[0] ?? 0)}?`,
      total: "¿Cuántos votos hay en total?",
    };
    const stem: MarkupLine[] = [`${intro} ${prompt(rng, prompts, ask[question], "")}`, shown];
    const listing = categories
      .map((category, position) => `${category}: $${votesOf(position)}$`)
      .join(", ");

    if (typeof answer === "string") {
      const ordered = [...categories].sort(
        (a, b) => votesOf(categories.indexOf(b)) - votesOf(categories.indexOf(a)),
      );
      const wrong = (question === "most" ? ordered.slice(1) : ordered.slice(0, -1).reverse()).slice(
        0,
        3,
      );
      return finishDraft({
        family: "data-graph",
        level,
        rng,
        calibration,
        stem,
        correct: textChoice(answer, "none"),
        distractors: wrong.map((category, position) =>
          textChoice(
            category,
            position === 0
              ? "picked-the-runner-up"
              : question === "most"
                ? "picked-a-smaller-value"
                : "picked-a-larger-value",
          ),
        ),
        pool: [
          reading,
          `Valores: ${listing}.`,
          `Compara los valores y busca el ${question === "most" ? "mayor" : "menor"}.`,
          "La opción es:",
          answer,
        ],
        numericValues: [unit, ...values],
        problem: { ...problem },
        fallback: "none",
      });
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    const distractors =
      question === "read"
        ? [
            numberChoice(
              symbols[asked[0] ?? 0] ?? 0,
              unit === 1 ? "read-wrong-row" : "forgot-the-key",
            ),
            numberChoice(votesOf(asked[0] ?? 0) + unit, "miscounted-a-symbol"),
            numberChoice(votesOf((asked[0] ?? 0) === 0 ? 1 : 0), "read-wrong-row"),
          ]
        : question === "difference"
          ? [
              numberChoice(votesOf(asked[0] ?? 0) + votesOf(asked[1] ?? 0), "added-instead"),
              numberChoice(
                Math.max(votesOf(asked[0] ?? 0), votesOf(asked[1] ?? 0)),
                "read-one-value",
              ),
              numberChoice(answer.toNumber() + unit, "miscounted-a-symbol"),
            ]
          : [
              numberChoice(total - votesOf(asked[0] ?? 0), "missed-a-category"),
              numberChoice(
                symbols.reduce((sum, value) => sum + value, 0),
                "forgot-the-key",
              ),
              numberChoice(total + unit, "miscounted-a-symbol"),
            ];
    return finishDraft({
      family: "data-graph",
      level,
      rng,
      calibration,
      stem,
      correct: numberChoice(answer, "none"),
      distractors,
      pool: [
        reading,
        `Valores: ${listing}.`,
        question === "total"
          ? "Suma todos los valores."
          : question === "difference"
            ? "Resta el valor menor del mayor."
            : "Busca la fila o barra que se pregunta.",
        "La respuesta es:",
        math(answer),
      ],
      numericValues: [unit, ...values],
      problem: { ...problem },
    });
  },
};
