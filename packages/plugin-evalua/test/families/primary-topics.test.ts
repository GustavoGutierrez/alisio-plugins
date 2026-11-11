import { beforeAll, describe, expect, it } from "vitest";
import { angleMeasure, classifyAngle } from "../../src/families/angle-measure.js";
import { clockTime } from "../../src/families/clock-time.js";
import { coordinates, quadrantOf } from "../../src/families/coordinates.js";
import { dataGraph } from "../../src/families/data-graph.js";
import { fractionDecimalPercent } from "../../src/families/fraction-decimal-percent.js";
import { fractionPart } from "../../src/families/fraction-part.js";
import { families, familyIds } from "../../src/families/index.js";
import { clockText, pesos, thousands, tier } from "../../src/families/kit.js";
import { missingNumber } from "../../src/families/missing-number.js";
import { moneyProblems } from "../../src/families/money.js";
import { multiples } from "../../src/families/multiples.js";
import { numberPattern } from "../../src/families/number-pattern.js";
import { perimeterArea } from "../../src/families/perimeter-area.js";
import { placeValue } from "../../src/families/place-value.js";
import { prismVolume } from "../../src/families/prism-volume.js";
import { likelihoodOf, simpleProbability } from "../../src/families/simple-probability.js";
import type { Family, ItemDraft } from "../../src/families/types.js";
import type { FigureSpec } from "../../src/figures/index.js";
import { figureSvg } from "../../src/figures/index.js";
import { checkKatexItem } from "../../src/katex.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LevelCalibration, LoadedKnowledge } from "../../src/knowledge/types.js";
import { tokenizeInline } from "../../src/markup.js";
import { Rational } from "../../src/math/rational.js";
import { createRng } from "../../src/math/rng.js";
import { type Level, levels } from "../../src/types.js";
import { verifyDraft } from "../../src/verify.js";

/** Every family added for the primary-school topics, with the topic and pack that ship it. */
const NEW_FAMILIES: ReadonlyArray<{ family: Family; topic: string }> = [
  { family: placeValue, topic: "primary-math/place-value" },
  { family: clockTime, topic: "primary-math/time-clock" },
  { family: moneyProblems, topic: "primary-math/money" },
  { family: numberPattern, topic: "primary-math/number-patterns" },
  { family: missingNumber, topic: "primary-math/missing-number" },
  { family: fractionPart, topic: "primary-math/intro-fractions" },
  { family: dataGraph, topic: "primary-math/pictograms-bars" },
  { family: perimeterArea, topic: "primary-math/perimeter-area" },
  { family: prismVolume, topic: "primary-math/prism-volume" },
  { family: angleMeasure, topic: "primary-math/angles-basic" },
  { family: coordinates, topic: "basic-math/coordinates" },
  { family: fractionDecimalPercent, topic: "primary-math/fraction-decimal-percent" },
  { family: simpleProbability, topic: "primary-math/simple-probability" },
  { family: multiples, topic: "basic-math/divisibility" },
];

const SEEDS = 120;

let knowledge: LoadedKnowledge;

beforeAll(async () => {
  knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
});

function calibrationFor(topicId: string, level: Level): LevelCalibration {
  const topic = knowledge.topics.find((entry) => entry.fullId === topicId);
  const calibration = knowledge.packs.find((pack) => pack.id === topic?.packId)?.levels[level];
  if (calibration === undefined) throw new Error(`no calibration for ${topicId}/${level}`);
  return calibration;
}

function drafts(family: Family, topic: string, level: Level, count = SEEDS): ItemDraft[] {
  const calibration = calibrationFor(topic, level);
  return Array.from({ length: count }, (_, seed) =>
    family.generate({ rng: createRng(`pt-${family.id}-${level}-${seed}`), level, calibration }),
  );
}

const figureOf = (draft: ItemDraft): FigureSpec | undefined => {
  for (const line of draft.stem)
    if (typeof line !== "string" && "figure" in line) return line.figure;
  return undefined;
};

describe("knowledge wiring", () => {
  it("registers every new family and ships every topic with a unique code", () => {
    for (const { family, topic } of NEW_FAMILIES) {
      expect(families[family.id], family.id).toBe(family);
      const loaded = knowledge.topics.find((entry) => entry.fullId === topic);
      expect(loaded?.sources, topic).toContainEqual(
        expect.objectContaining({ kind: "family", family: family.id }),
      );
      expect(loaded?.supports.multiple_choice, topic).toBe(false);
    }
    const codes = knowledge.topics.map((topic) => topic.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(knowledge.report.results).toEqual([]);
  });

  it("merges parity/multiples into divisibility and mean/median into statistics for grades 4-5", () => {
    const divisibility = knowledge.topics.find(
      (topic) => topic.fullId === "basic-math/divisibility",
    );
    expect(divisibility?.grades).toEqual(["Cuarto", "Quinto", "Sexto", "Séptimo"]);
    expect(divisibility?.objectives.map((objective) => objective.id)).toContain("parity-multiples");
    const statistics = knowledge.topics.find((topic) => topic.fullId === "basic-math/statistics");
    expect(statistics?.grades.slice(0, 2)).toEqual(["Cuarto", "Quinto"]);
  });

  it("gives primary grades one to three their own topics", () => {
    for (const grade of ["Primero", "Segundo", "Tercero"]) {
      const count = knowledge.topics.filter((topic) => topic.grades.includes(grade)).length;
      expect(count, grade).toBeGreaterThanOrEqual(5);
    }
  });
});

describe.each(NEW_FAMILIES)("$family.id", ({ family, topic }) => {
  it.each(levels)(
    "level %s: verified drafts, wrong distractors, valid math and figures",
    (level) => {
      const calibration = calibrationFor(topic, level);
      for (const [seed, draft] of drafts(family, topic, level).entries()) {
        const context = `${family.id}/${level}/${seed}`;
        expect(verifyDraft(draft, family, level, calibration), context).toEqual([]);
        const correct = draft.options.filter((option) => option.correct);
        expect(correct, context).toHaveLength(1);
        expect(correct[0]?.value, context).toBe(draft.answer.canonical);
        for (const option of draft.options.filter((entry) => !entry.correct)) {
          expect(option.value, context).not.toBe(draft.answer.canonical);
          expect(option.error, context).not.toBe("none");
        }
        const item = {
          stem: draft.stem,
          options: draft.options,
          solution: draft.solution,
          answer: draft.answer,
        };
        expect(checkKatexItem(item as never), context).toEqual([]);
        const figure = figureOf(draft);
        if (figure !== undefined) {
          const svg = figureSvg(figure);
          expect(svg, context).toContain("<svg");
          expect(svg, context).toContain("aria-label=");
          expect(svg.length, context).toBeLessThan(40_000);
        }
      }
    },
  );
});

describe("answers computed from the same parameters the figures draw", () => {
  it("clock-time: the clock shows the read time and basico uses quarter hours", () => {
    for (const level of levels) {
      for (const draft of drafts(clockTime, "primary-math/time-clock", level)) {
        const figure = figureOf(draft);
        if (draft.problem.variant !== "read" || figure === undefined) continue;
        const { hour, minute } = figure.params as { hour: number; minute: number };
        expect(draft.answer.canonical).toBe(clockText(hour, minute));
        if (level === "basico") expect(minute % 15).toBe(0);
      }
    }
    expect(clockTime.solve({ variant: "end-time", hour: 8, minute: 45, duration: 30 })).toBe(
      "9:15",
    );
    expect(
      String(
        clockTime.solve({
          variant: "elapsed",
          hour: 8,
          minute: 15,
          endHour: 9,
          endMinute: 40,
          unit: "minutes",
        }),
      ),
    ).toBe("85");
  });

  it("fraction-part: the shaded parts of the figure are the answer", () => {
    for (const draft of drafts(fractionPart, "primary-math/intro-fractions", "intermedio")) {
      const figure = figureOf(draft);
      if (figure === undefined) continue;
      const { parts, shaded } = figure.params as { parts: number; shaded: number };
      const counted = draft.problem.variant === "unshaded" ? parts - shaded : shaded;
      expect(draft.answer.canonical).toBe(Rational.of(counted, parts).toString());
    }
    expect(
      String(fractionPart.solve({ variant: "of-a-set", parts: 4, shaded: 3, total: 12 })),
    ).toBe("9");
  });

  it("data-graph: pictogram symbols times the key are the values asked about", () => {
    for (const draft of drafts(dataGraph, "primary-math/pictograms-bars", "avanzado")) {
      const figure = figureOf(draft);
      const values = draft.problem.values as number[];
      if (figure?.kind === "pictogram") {
        const { symbols, unit } = figure.params as { symbols: number[]; unit: number };
        expect(symbols.map((count) => count * unit)).toEqual(values);
      }
      if (figure?.kind === "bar-chart")
        expect((figure.params as { values: number[] }).values).toEqual(values);
    }
    expect(
      dataGraph.solve({
        question: "most",
        categories: ["A", "B", "C"],
        values: [2, 7, 4],
        asked: [0],
      }),
    ).toBe("B");
  });

  it("perimeter-area and prism-volume: the drawn sides and edges give the answer", () => {
    for (const draft of drafts(perimeterArea, "primary-math/perimeter-area", "intermedio")) {
      const params = figureOf(draft)?.params as {
        width: number;
        height: number;
        cutWidth?: number;
        cutHeight?: number;
      };
      const area = params.width * params.height - (params.cutWidth ?? 0) * (params.cutHeight ?? 0);
      const perimeter = 2 * (params.width + params.height);
      expect([String(area), String(perimeter)]).toContain(draft.answer.canonical);
    }
    expect(
      String(
        perimeterArea.solve({ variant: "l-area", width: 6, height: 5, cutWidth: 2, cutHeight: 3 }),
      ),
    ).toBe("24");
    for (const draft of drafts(prismVolume, "primary-math/prism-volume", "basico")) {
      const { length, width, height } = (figureOf(draft)?.params ?? {}) as Record<string, number>;
      expect(draft.answer.canonical).toBe(String((length ?? 0) * (width ?? 0) * (height ?? 0)));
    }
  });

  it("coordinates: the named point is drawn where the answer says, first quadrant at basico", () => {
    for (const level of levels) {
      for (const draft of drafts(coordinates, "basic-math/coordinates", level)) {
        const figure = figureOf(draft);
        const points =
          (figure?.params as { points?: Array<{ x: number; y: number }> } | undefined)?.points ??
          [];
        if (level === "basico")
          for (const point of points) expect(Math.min(point.x, point.y)).toBeGreaterThanOrEqual(0);
        if (draft.problem.variant === "read-point") {
          const target = points[Number(draft.problem.target)];
          expect(draft.answer.canonical).toBe(`(${target?.x},${target?.y})`);
        }
      }
    }
    expect(quadrantOf(-3, 4)).toBe("II");
    expect(quadrantOf(2, -1)).toBe("IV");
  });

  it("simple-probability and angles: the drawn bag and angle match the answer", () => {
    for (const draft of drafts(simpleProbability, "primary-math/simple-probability", "avanzado")) {
      const counts = ((figureOf(draft)?.params ?? {}) as { counts?: number[] }).counts;
      expect(counts).toEqual(draft.problem.counts);
    }
    expect(likelihoodOf(0, 5)).toBe("imposible");
    expect(likelihoodOf(5, 5)).toBe("seguro");
    expect(likelihoodOf(4, 5)).toBe("muy probable");
    expect(likelihoodOf(1, 5)).toBe("poco probable");
    for (const draft of drafts(angleMeasure, "primary-math/angles-basic", "basico")) {
      const figure = figureOf(draft);
      if (figure === undefined) continue;
      expect(draft.answer.canonical).toBe(
        classifyAngle((figure.params as { degrees: number }).degrees),
      );
    }
  });
});

describe("hand-checked answers", () => {
  it("solves known problems exactly", () => {
    expect(String(placeValue.solve({ variant: "digit-value", digit: 4, place: 2 }))).toBe("400");
    expect(
      String(
        placeValue.solve({
          variant: "compose",
          parts: [
            { count: 3, place: 2 },
            { count: 5, place: 0 },
          ],
        }),
      ),
    ).toBe("305");
    expect(
      String(moneyProblems.solve({ variant: "change", quantity: 3, price: 2500, bill: 10000 })),
    ).toBe("2500");
    expect(String(moneyProblems.solve({ variant: "how-many", price: 1500, bill: 5000 }))).toBe("3");
    expect(
      String(numberPattern.solve({ rule: "add", start: 3, step: 4, length: 5, missing: 4 })),
    ).toBe("19");
    expect(String(missingNumber.solve({ form: "balance", a: 7, b: 5, c: 0, d: 4 }))).toBe("8");
    expect(String(fractionDecimalPercent.solve({ numerator: 3, denominator: 4 }))).toBe("3/4");
    expect(String(multiples.solve({ variant: "divisor-count", base: 12 }))).toBe("6");
    expect(String(angleMeasure.solve({ variant: "around", a: 120, b: 90 }))).toBe("150");
  });

  it("formats pesos, thousands and per-level tables", () => {
    expect(thousands(12500)).toBe("12{.}500");
    expect(pesos(2500)).toBe("$\\text{\\textdollar}2{.}500$");
    // The peso sign must never be a bare `$`: it would end the inline formula.
    expect(
      tokenizeInline(`Cuesta ${pesos(2500)}.`).filter((token) => token.kind === "math"),
    ).toHaveLength(1);
    expect(tier(0, [["a"], ["b"]])).toEqual(["a"]);
    expect(tier(3, [["a"], ["b"]])).toEqual(["b"]);
  });

  it("keeps basico money items to counting coins and fractions-decimals at basico", () => {
    for (const draft of drafts(moneyProblems, "primary-math/money", "basico")) {
      expect(draft.problem.variant).toBe("count");
    }
    for (const draft of drafts(
      fractionDecimalPercent,
      "primary-math/fraction-decimal-percent",
      "basico",
    )) {
      expect([draft.problem.from, draft.problem.to]).not.toContain("percent");
    }
  });
});
