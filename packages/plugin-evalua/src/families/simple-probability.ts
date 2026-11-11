import type { FigureSpec } from "../figures/index.js";
import { Rational } from "../math/rational.js";
import {
  distinctInts,
  finishDraft,
  fractionMath,
  levelHigh,
  levelIndex,
  shownChoice,
  textChoice,
  tier,
} from "./kit.js";
import type { OptionCandidate } from "./options.js";
import { prompt } from "./shared.js";
import type { Family, FamilyContext, ItemDraft } from "./types.js";

type Variant = "likelihood" | "most-likely" | "probability" | "either";

const COLOURS = [
  { mark: "R", name: "rojas", one: "roja" },
  { mark: "A", name: "azules", one: "azul" },
  { mark: "V", name: "verdes", one: "verde" },
  { mark: "N", name: "negras", one: "negra" },
];

const LIKELIHOOD = ["seguro", "muy probable", "poco probable", "imposible"] as const;
type Likelihood = (typeof LIKELIHOOD)[number];

/** The word for an event with `favourable` of `total` equally likely outcomes (never a tie). */
export function likelihoodOf(favourable: number, total: number): Likelihood {
  if (favourable === 0) return "imposible";
  if (favourable === total) return "seguro";
  return favourable * 2 > total ? "muy probable" : "poco probable";
}

const MAX_BALLS = 30;

/** Likelihood words, the most likely outcome and probability as a fraction (DBA 2-3 #11, 5 #12). */
export const simpleProbability: Family = {
  id: "simple-probability",
  solve(problem: Record<string, unknown>): Rational | string {
    const counts = (problem.counts as unknown[]).map(Number);
    const total = counts.reduce((sum, value) => sum + value, 0);
    const asked = (problem.asked as unknown[]).map(Number);
    const favourable = asked.reduce((sum, position) => sum + (counts[position] ?? 0), 0);
    if (problem.variant === "likelihood") return likelihoodOf(favourable, total);
    if (problem.variant === "most-likely") {
      return COLOURS[counts.indexOf(Math.max(...counts))]?.one ?? "";
    }
    return Rational.of(favourable, total);
  },
  generate({ rng, level, calibration, prompts }: FamilyContext): ItemDraft {
    const index = levelIndex(level);
    const variants = tier<Variant>(index, [
      ["likelihood"],
      ["likelihood", "most-likely", "probability"],
      ["most-likely", "probability", "either"],
      ["probability", "either"],
    ]);
    const variant = rng.pick(variants);
    const kinds =
      variant === "likelihood" ? rng.int(2, 3) : variant === "most-likely" ? 4 : rng.int(2, 4);
    const cap = Math.max(kinds, Math.min(MAX_BALLS, levelHigh(calibration, MAX_BALLS)));
    const perKind = Math.max(1, Math.min(9, Math.floor(cap / kinds)));
    const counts =
      variant === "most-likely"
        ? distinctInts(rng, kinds, 1, Math.max(kinds, perKind))
        : Array.from({ length: kinds }, () => rng.int(1, perKind));
    const total = counts.reduce((sum, value) => sum + value, 0);
    const colours = COLOURS.slice(0, kinds);
    const figure: FigureSpec = {
      kind: "urn",
      params: {
        marks: colours.map((colour) => colour.mark),
        names: colours.map((colour) => colour.name),
        counts,
      },
    };
    const story = `En una bolsa hay ${colours
      .map(
        (colour, position) =>
          `$${counts[position]}$ bolas ${counts[position] === 1 ? colour.one : colour.name}`,
      )
      .join(", ")
      .replace(/, ([^,]*)$/, " y $1")}. Se saca una bola sin mirar.`;
    const listing = colours
      .map((colour, position) => `${colour.name}: $${counts[position]}$`)
      .join(", ");

    if (variant === "likelihood") {
      // One question in four asks about a colour that is not in the bag (impossible) or about any
      // of the colours (certain), so every word is a possible answer.
      const roll = rng.int(0, 3);
      const asked =
        roll === 0
          ? []
          : roll === 1
            ? colours.map((_, position) => position)
            : [rng.int(0, kinds - 1)];
      const favourable = asked.reduce((sum, position) => sum + (counts[position] ?? 0), 0);
      if (favourable * 2 === total && asked.length === 1)
        counts[asked[0] ?? 0] = (counts[asked[0] ?? 0] ?? 1) + 1;
      const finalTotal = counts.reduce((sum, value) => sum + value, 0);
      const finalFavourable = asked.reduce((sum, position) => sum + (counts[position] ?? 0), 0);
      const answer = likelihoodOf(finalFavourable, finalTotal);
      const event =
        roll === 0
          ? `una bola ${COLOURS[kinds]?.one ?? "blanca"}`
          : roll === 1
            ? "una bola de alguno de esos colores"
            : `una bola ${colours[asked[0] ?? 0]?.one ?? ""}`;
      const fixedStory = `En una bolsa hay ${colours
        .map(
          (colour, position) =>
            `$${counts[position]}$ bolas ${counts[position] === 1 ? colour.one : colour.name}`,
        )
        .join(", ")
        .replace(/, ([^,]*)$/, " y $1")}. Se saca una bola sin mirar.`;
      return finishDraft({
        family: "simple-probability",
        level,
        rng,
        calibration,
        stem: [
          `${fixedStory} ${prompt(rng, prompts, `¿Qué tan probable es sacar ${event}?`, "")}`,
          { figure: { ...figure, params: { ...figure.params, counts: [...counts] } } },
        ],
        correct: textChoice(answer, "none", capital(answer)),
        distractors: LIKELIHOOD.filter((entry) => entry !== answer).map((entry) =>
          textChoice(entry, errorFor(answer, entry), capital(entry)),
        ),
        pool: [
          "Seguro: siempre pasa. Imposible: nunca pasa.",
          "Muy probable: hay más casos a favor que en contra. Poco probable: hay menos.",
          `Bolas en la bolsa: ${listing}.`,
          `Casos a favor: $${finalFavourable}$ de $${finalTotal}$.`,
          "El suceso es:",
          answer,
        ],
        numericValues: [...counts],
        problem: { variant, counts: [...counts], asked },
        fallback: "none",
      });
    }

    if (variant === "most-likely") {
      const answer = COLOURS[counts.indexOf(Math.max(...counts))]?.one ?? "";
      const ranked = colours
        .map((colour, position) => ({ colour, count: counts[position] ?? 0 }))
        .sort((a, b) => b.count - a.count);
      return finishDraft({
        family: "simple-probability",
        level,
        rng,
        calibration,
        stem: [
          `${story} ${prompt(rng, prompts, "¿De qué color es más probable que salga la bola?", "")}`,
          { figure },
        ],
        correct: textChoice(answer, "none", `Bola ${answer}`),
        distractors: ranked
          .slice(1)
          .map((entry, position) =>
            textChoice(
              entry.colour.one,
              position === ranked.length - 2 ? "picked-the-least-likely" : "picked-a-less-likely",
              `Bola ${entry.colour.one}`,
            ),
          ),
        pool: [
          `Bolas en la bolsa: ${listing}.`,
          "Es más probable el color que tiene más bolas.",
          `El mayor número de bolas es $${ranked[0]?.count ?? 0}$.`,
          "El color más probable es:",
          answer,
        ],
        numericValues: counts,
        problem: { variant, counts, asked: [] },
        fallback: "none",
      });
    }

    const first = rng.int(0, kinds - 1);
    const second = (first + 1) % kinds;
    const asked = variant === "either" && kinds > 2 ? [first, second] : [first];
    const favourable = asked.reduce((sum, position) => sum + (counts[position] ?? 0), 0);
    const event = asked.map((position) => colours[position]?.one ?? "").join(" o ");
    const value = Rational.of(favourable, total);
    const candidates: Array<OptionCandidate | undefined> = [
      total - favourable > 0
        ? shownChoice(
            Rational.of(favourable, total - favourable),
            fractionMath(favourable, total - favourable),
            "favourable-to-unfavourable",
          )
        : undefined,
      total - favourable > 0
        ? shownChoice(
            Rational.of(total - favourable, total),
            fractionMath(total - favourable, total),
            "found-the-complement",
          )
        : undefined,
      shownChoice(Rational.of(1, total), fractionMath(1, total), "one-outcome-only"),
      shownChoice(
        Rational.of(total, favourable),
        fractionMath(total, favourable),
        "inverted-the-fraction",
      ),
      asked.length > 1
        ? shownChoice(
            Rational.of(counts[first] ?? 0, total),
            fractionMath(counts[first] ?? 0, total),
            "counted-one-colour",
          )
        : shownChoice(
            Rational.of(favourable, total + 1),
            fractionMath(favourable, total + 1),
            "counted-the-bag",
          ),
    ];
    return finishDraft({
      family: "simple-probability",
      level,
      rng,
      calibration,
      stem: [
        `${story} ${prompt(rng, prompts, `¿Cuál es la probabilidad de sacar una bola ${event}?`, "")}`,
        { figure },
      ],
      correct: shownChoice(value, fractionMath(favourable, total), "none"),
      distractors: candidates.filter((entry): entry is OptionCandidate => entry !== undefined),
      pool: [
        "La probabilidad es casos favorables sobre casos posibles.",
        `Casos posibles (todas las bolas): $${total}$.`,
        `Casos favorables (bolas ${event}): $${favourable}$.`,
        `$P = \\dfrac{${favourable}}{${total}}$`,
        "La probabilidad es:",
        fractionMath(favourable, total),
      ],
      numericValues: counts,
      problem: { variant, counts, asked },
      fallback: "none",
    });
  },
};

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function errorFor(answer: Likelihood, chosen: Likelihood): string {
  if (chosen === "seguro" || chosen === "imposible") return "confused-certain-with-likely";
  return answer === "seguro" || answer === "imposible"
    ? "confused-certain-with-likely"
    : "compared-the-wrong-cases";
}
