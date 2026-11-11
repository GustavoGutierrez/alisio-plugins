import { beforeAll, describe, expect, it } from "vitest";
import { absoluteValue } from "../../src/families/absolute-value.js";
import { boxPlot } from "../../src/families/box-plot.js";
import { circleMeasure } from "../../src/families/circle-measure.js";
import { compoundProbability } from "../../src/families/compound-probability.js";
import { counting, factorial, falling } from "../../src/families/counting.js";
import { piText, sqrtParts, surdMath, surdText } from "../../src/families/exact.js";
import { expLog } from "../../src/families/exp-log.js";
import { families, familyIds } from "../../src/families/index.js";
import { mapScale } from "../../src/families/map-scale.js";
import { numberSets } from "../../src/families/number-sets.js";
import { proportion } from "../../src/families/proportion.js";
import { pythagorean, triplesUpTo } from "../../src/families/pythagorean.js";
import { quadraticFunction, standardForm } from "../../src/families/quadratic-function.js";
import { roundSolids, volumeOverPi } from "../../src/families/round-solids.js";
import { scientificNotation, sciText } from "../../src/families/scientific-notation.js";
import { nTermText, sequences } from "../../src/families/sequences.js";
import { similarityThales } from "../../src/families/similarity-thales.js";
import { triangleAngles } from "../../src/families/triangle-angles.js";
import type { Family, ItemDraft } from "../../src/families/types.js";
import { evaluateCurve, type FigureSpec, figureSvg } from "../../src/figures/index.js";
import { checkKatexItem } from "../../src/katex.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LevelCalibration, LoadedKnowledge } from "../../src/knowledge/types.js";
import { Rational } from "../../src/math/rational.js";
import { createRng } from "../../src/math/rng.js";
import { fiveNumbers, median, variance } from "../../src/math/stats.js";
import { type Level, levels } from "../../src/types.js";
import { verifyDraft } from "../../src/verify.js";

/** Every family added or extended for grades 6-9, with the topic that ships it. */
const SECONDARY: ReadonlyArray<{ family: Family; topic: string }> = [
  { family: absoluteValue, topic: "basic-math/absolute-value" },
  { family: scientificNotation, topic: "basic-math/scientific-notation" },
  { family: mapScale, topic: "geometry/scales-maps" },
  { family: triangleAngles, topic: "geometry/triangle-angles" },
  { family: circleMeasure, topic: "geometry/circle" },
  { family: compoundProbability, topic: "probability-statistics/compound-probability" },
  { family: pythagorean, topic: "geometry/pythagorean" },
  { family: similarityThales, topic: "geometry/similarity-thales" },
  { family: roundSolids, topic: "geometry/round-solids-volume" },
  { family: sequences, topic: "functions/sequences" },
  { family: counting, topic: "probability-statistics/counting-techniques" },
  { family: expLog, topic: "functions/exp-log" },
  { family: quadraticFunction, topic: "functions/quadratic-function" },
  { family: numberSets, topic: "basic-math/rational-numbers" },
  { family: boxPlot, topic: "basic-math/statistics" },
  { family: proportion, topic: "basic-math/percentages" },
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
    family.generate({ rng: createRng(`st-${family.id}-${level}-${seed}`), level, calibration }),
  );
}

const figureOf = (draft: ItemDraft): FigureSpec | undefined => {
  for (const line of draft.stem)
    if (typeof line !== "string" && "figure" in line) return line.figure;
  return undefined;
};

describe("knowledge wiring", () => {
  it("ships the three new packs with Spanish names and their topics", () => {
    const packs = new Map(knowledge.packs.map((pack) => [pack.id, pack]));
    expect(packs.get("geometry")?.name.es).toBe("Geometría y medición");
    expect(packs.get("probability-statistics")?.name.es).toBe("Probabilidad y estadística");
    expect(packs.get("functions")?.name.es).toBe("Funciones y sucesiones");
    expect(
      packs
        .get("geometry")
        ?.topics.map((topic) => topic.id)
        .sort(),
    ).toEqual([
      "circle",
      "pythagorean",
      "round-solids-volume",
      "scales-maps",
      "similarity-thales",
      "triangle-angles",
    ]);
    expect(knowledge.report.results).toEqual([]);
  });

  it("registers every family, wires it to its topic and keeps topic codes unique", () => {
    for (const { family, topic } of SECONDARY) {
      expect(families[family.id], family.id).toBe(family);
      const loaded = knowledge.topics.find((entry) => entry.fullId === topic);
      expect(loaded?.sources, topic).toContainEqual(
        expect.objectContaining({ kind: "family", family: family.id }),
      );
      expect(loaded?.supports.multiple_choice, topic).toBe(false);
    }
    const codes = knowledge.topics.map((topic) => topic.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("merges ratio-proportion, real numbers and box plots into existing topics", () => {
    const byId = (id: string) => knowledge.topics.find((topic) => topic.fullId === id);
    expect(byId("basic-math/percentages")?.objectives.map((o) => o.id)).toContain(
      "ratio-proportion",
    );
    expect(byId("basic-math/rational-numbers")?.objectives.map((o) => o.id)).toContain(
      "rational-irrational",
    );
    expect(byId("basic-math/statistics")?.sources).toContainEqual({
      kind: "family",
      family: "box-plot",
      levels: ["avanzado", "genio"],
    });
    for (const merged of ["ratio-proportion", "real-numbers", "boxplot-quartiles"]) {
      expect(knowledge.topics.some((topic) => topic.id === merged)).toBe(false);
    }
  });

  it("names grades the Colombian way and gives grades six to nine new topics", () => {
    const known = ["Sexto", "Séptimo", "Octavo", "Noveno", "Décimo"];
    for (const { topic } of SECONDARY) {
      const grades = knowledge.topics.find((entry) => entry.fullId === topic)?.grades ?? [];
      for (const grade of grades.filter((entry) => !["Cuarto", "Quinto"].includes(entry))) {
        expect(known, `${topic}: ${grade}`).toContain(grade);
      }
    }
    const noveno = knowledge.topics.filter((topic) => topic.grades.includes("Noveno"));
    expect(noveno.length).toBeGreaterThanOrEqual(10);
  });
});

describe.each(SECONDARY)("$family.id", ({ family, topic }) => {
  it.each(levels)(
    "level %s: verified drafts, tagged wrong distractors, valid math and figures",
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
          expect(svg, context).toMatch(/aria-label="[^"]+"/);
          expect(svg, context).not.toMatch(/href=|<image|<script/);
          expect(svg.length, context).toBeLessThan(40_000);
        }
      }
    },
  );
});

describe("answers computed from the same parameters the figures draw", () => {
  it("pythagorean: the drawn legs and labels give the answer", () => {
    for (const level of levels) {
      for (const draft of drafts(pythagorean, "geometry/pythagorean", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const { legs, sideLabels } = figure.params as { legs: number[]; sideLabels: string[] };
        const [p, q] = legs as [number, number];
        if (sideLabels[2] === "?" || sideLabels[2] === "x") {
          expect(draft.answer.canonical).toBe(surdText(Rational.one, Math.round(p * p + q * q)));
        }
        expect(sideLabels[0]).toMatch(new RegExp(`^${p}\\b`));
      }
    }
    expect(String(pythagorean.solve({ variant: "hypotenuse", a: 6, b: 8, c: 0 }))).toBe("10");
    expect(String(pythagorean.solve({ variant: "radical", ask: "hyp", a: 2, b: 4, c: 0 }))).toBe(
      "2sqrt5",
    );
    expect(pythagorean.solve({ variant: "is-right", a: 5, b: 12, c: 14 })).toBe("no");
    expect(triplesUpTo(20)).toContainEqual([6, 8, 10]);
  });

  it("triangle-angles: the drawn angles hold the given values and the answer", () => {
    for (const draft of drafts(triangleAngles, "geometry/triangle-angles", "basico")) {
      const params = figureOf(draft)?.params as { angles?: number[]; angleLabels?: string[] };
      if (params?.angles === undefined) continue;
      expect(params.angles.reduce((sum, angle) => sum + angle, 0)).toBe(180);
      const hidden = params.angleLabels?.indexOf("x") ?? -1;
      expect(String(params.angles[hidden])).toBe(draft.answer.canonical);
    }
    expect(String(triangleAngles.solve({ variant: "regular-interior", n: 8 }))).toBe("135");
    expect(String(triangleAngles.solve({ variant: "exterior", a: 40, b: 30 }))).toBe("70");
  });

  it("circle and round solids: the labelled measures give the exact answer in π", () => {
    for (const draft of drafts(circleMeasure, "geometry/circle", "intermedio")) {
      const params = figureOf(draft)?.params as { show: string; value: number | string };
      if (params === undefined || typeof params.value !== "number") continue;
      const r =
        params.show === "diameter" ? Rational.of(params.value, 2) : Rational.of(params.value);
      expect([
        piText(r.mul(Rational.of(2))),
        piText(r.mul(r)),
        piText(r.mul(r).div(Rational.of(2))),
      ]).toContain(draft.answer.canonical);
    }
    expect(circleMeasure.solve({ variant: "area", radius: "7/2" })).toBe("49/4pi");
    for (const draft of drafts(roundSolids, "geometry/round-solids-volume", "basico")) {
      const figure = figureOf(draft);
      const { radius, height } = (figure?.params ?? {}) as { radius: number; height: number };
      const solid = figure?.kind === "cone" ? "cone" : "cylinder";
      expect(draft.answer.canonical).toBe(piText(volumeOverPi(solid, radius, height)));
    }
    expect(roundSolids.solve({ solid: "sphere", r: 3, h: 0 })).toBe("36pi");
    expect(roundSolids.solve({ solid: "cone", r: 3, h: 4 })).toBe("12pi");
  });

  it("similarity-thales: the drawn sides and Thales labels give the answer", () => {
    for (const draft of drafts(similarityThales, "geometry/similarity-thales", "intermedio")) {
      const figure = figureOf(draft);
      if (figure === undefined) continue;
      const params = figure.params as Record<string, unknown>;
      if (params.mode === "nested") {
        const [ad, db, ae] = (params.labels as string[]).map(Number) as [number, number, number];
        expect(draft.answer.canonical).toBe(Rational.of(db * ae, ad).toString());
      } else if (draft.problem.variant === "similar-side") {
        const hidden = (params.imageLabels as string[]).indexOf("x");
        const side = (params.sides as number[])[hidden] ?? 0;
        expect(draft.answer.canonical).toBe(
          Rational.of(side)
            .mul(Rational.parse(String(draft.problem.k)))
            .toString(),
        );
      }
    }
  });

  it("compound-probability and counting: the tree draws the counted outcomes", () => {
    for (const draft of drafts(
      compoundProbability,
      "probability-statistics/compound-probability",
      "basico",
    )) {
      const stages = (figureOf(draft)?.params as { stages?: string[][] } | undefined)?.stages;
      if (stages === undefined) continue;
      expect(String(stages.reduce((total, stage) => total * stage.length, 1))).toBe(
        draft.answer.canonical,
      );
    }
    for (const draft of drafts(counting, "probability-statistics/counting-techniques", "basico")) {
      const stages = (figureOf(draft)?.params as { stages?: string[][] } | undefined)?.stages;
      if (stages === undefined) continue;
      expect(String(stages.reduce((total, stage) => total * stage.length, 1))).toBe(
        draft.answer.canonical,
      );
    }
    expect(
      String(compoundProbability.solve({ variant: "two-draws", red: 3, blue: 2, replace: false })),
    ).toBe("3/10");
    expect(
      String(compoundProbability.solve({ variant: "coins", coins: 3, event: "at-least-one" })),
    ).toBe("7/8");
    expect(falling(10, 3)).toBe(720);
    expect(factorial(5)).toBe(120);
  });

  it("quadratic-function and exp-log: the plotted curve passes through the marked points", () => {
    for (const level of ["avanzado", "genio"] as const) {
      for (const draft of drafts(quadraticFunction, "functions/quadratic-function", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const { curves, points } = figure.params as {
          curves: Array<{ type: "polynomial"; coefficients: number[] }>;
          points: Array<{ x: number; y: number }>;
        };
        const [curve] = curves;
        const [vertex] = points;
        if (curve === undefined || vertex === undefined) throw new Error("plot without data");
        expect(evaluateCurve(curve, vertex.x)).toBe(vertex.y);
        expect(draft.answer.canonical).toBe(`(${vertex.x},${vertex.y})`);
      }
      for (const draft of drafts(expLog, "functions/exp-log", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const { curves, points } = figure.params as {
          curves: Array<{ type: "exponential"; a: number; base: number }>;
          points: Array<{ x: number; y: number }>;
        };
        const [curve] = curves;
        if (curve === undefined) throw new Error("plot without a curve");
        for (const point of points) expect(evaluateCurve(curve, point.x)).toBeCloseTo(point.y, 9);
        expect(draft.answer.canonical).toBe(String(curve.base));
      }
    }
    expect(standardForm(1, 2, -1)).toEqual({ a: 1, b: -4, c: 3 });
    expect(quadraticFunction.solve({ variant: "roots", a: 1, h: 2, k: -1 })).toBe("{1,3}");
    expect(
      String(expLog.solve({ variant: "log-rules", base: 2, k: 3, j: 2, rule: "product" })),
    ).toBe("5");
  });

  it("box-plot: the plot draws the five-number summary of the data", () => {
    for (const draft of drafts(boxPlot, "basic-math/statistics", "genio")) {
      const figure = figureOf(draft);
      if (figure === undefined) continue;
      const five = fiveNumbers(draft.problem.data as number[]);
      const params = figure.params as Record<string, number>;
      expect(params.q1).toBe(Number(five.q1.n) / Number(five.q1.d));
      expect(params.median).toBe(Number(five.median.n) / Number(five.median.d));
      expect(params.q3).toBe(Number(five.q3.n) / Number(five.q3.d));
    }
  });

  it("absolute-value and map-scale: the number line and the map draw the asked values", () => {
    for (const draft of drafts(absoluteValue, "basic-math/absolute-value", "intermedio")) {
      const params = figureOf(draft)?.params as { points?: Array<{ value: number }> } | undefined;
      if (params?.points === undefined) continue;
      const [p, q] = params.points;
      if (draft.problem.variant === "distance") {
        expect(draft.answer.canonical).toBe(String(Math.abs((p?.value ?? 0) - (q?.value ?? 0))));
      } else {
        expect(draft.answer.canonical).toBe(String(Math.abs(p?.value ?? 0)));
      }
    }
    for (const draft of drafts(mapScale, "geometry/scales-maps", "basico")) {
      const params = figureOf(draft)?.params as { length: number; scale: string };
      if (draft.problem.variant !== "real-distance") continue;
      const scale = Number(params.scale.replace(/^1:/, "").replace(/\./g, ""));
      const cmPer = draft.problem.unit === "km" ? 100_000 : 100;
      expect(draft.answer.canonical).toBe(Rational.of(params.length * scale, cmPer).toString());
    }
  });
});

describe("hand-checked answers and helpers", () => {
  it("solves known problems exactly", () => {
    expect(scientificNotation.solve({ variant: "to-scientific", tenths: 45, exponent: 7 })).toBe(
      "4.5e7",
    );
    expect(
      scientificNotation.solve({
        variant: "multiply",
        tenths: 30,
        exponent: 4,
        tenths2: 50,
        exponent2: 3,
      }),
    ).toBe("1.5e8");
    expect(sciText(Rational.of(3, 10_000))).toBe("3e-4");
    expect(sequences.solve({ variant: "arithmetic-rule", a1: "5", step: "3", n: 0 })).toBe("3n+2");
    expect(nTermText(-1, -4)).toBe("-n-4");
    expect(String(sequences.solve({ variant: "geometric-nth", a1: "2", step: "3", n: 4 }))).toBe(
      "54",
    );
    expect(numberSets.solve({ variant: "repeating", value: "4/9" }).toString()).toBe("4/9");
    expect(String(proportion.solve({ variant: "ratio-split", a: 2, b: 3, c: 40 }))).toBe("16");
    expect(String(proportion.solve({ variant: "inverse", a: 4, b: 6, c: 3 }))).toBe("8");
    expect(String(proportion.solve({ a: 2, b: 3, c: 6 }))).toBe("4");
    expect(
      mapScale.solve({ variant: "real-distance", scale: 50_000, unit: "km", drawing: "3" }),
    ).toEqual(Rational.of(3, 2));
  });

  it("writes exact π multiples, simplified radicals and statistics", () => {
    expect(piText(Rational.of(9, 2))).toBe("9/2pi");
    expect(sqrtParts(72)).toEqual({ outside: 6, inside: 2 });
    expect(surdText(Rational.one, 49)).toBe("7");
    expect(surdMath(Rational.of(1, 2), 12)).toBe("$\\sqrt{3}$");
    expect(surdMath(Rational.of(1, 2), 3)).toBe("$\\dfrac{\\sqrt{3}}{2}$");
    expect(surdMath(Rational.of(-3, 2), 2)).toBe("$-\\dfrac{3\\sqrt{2}}{2}$");
    expect(surdMath(Rational.of(3), 2)).toBe("$3\\sqrt{2}$");
    const data = [1, 3, 4, 7, 8, 9, 12];
    expect(fiveNumbers(data)).toEqual({
      min: Rational.of(1),
      q1: Rational.of(3),
      median: Rational.of(7),
      q3: Rational.of(9),
      max: Rational.of(12),
    });
    expect(median([1, 2, 3, 4])).toEqual(Rational.of(5, 2));
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toEqual(Rational.of(4));
  });
});
