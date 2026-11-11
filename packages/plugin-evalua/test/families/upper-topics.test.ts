import { beforeAll, describe, expect, it } from "vitest";
import { choose, combinatorics } from "../../src/families/combinatorics.js";
import { conditionalProbability } from "../../src/families/conditional-probability.js";
import { conics } from "../../src/families/conics.js";
import {
  derivatives,
  derive,
  evaluateTerms,
  type Term,
  termsLatex,
  termsText,
} from "../../src/families/derivatives.js";
import { dispersion, wholeVarianceData } from "../../src/families/dispersion.js";
import { functionProperties } from "../../src/families/function-properties.js";
import { families, familyIds } from "../../src/families/index.js";
import { intervalInequality } from "../../src/families/interval-inequality.js";
import { intervalLatex, intervalText, span } from "../../src/families/intervals.js";
import { evaluate, rateLimits } from "../../src/families/rate-limits.js";
import {
  exactText,
  quadrantOf,
  radianPlain,
  referenceAngle,
  trigValue,
} from "../../src/families/trig.js";
import { missingSideText, surdNumber, trigRatios } from "../../src/families/trig-ratios.js";
import type { Family, ItemDraft } from "../../src/families/types.js";
import { solutionsOf, unitCircle } from "../../src/families/unit-circle.js";
import { evaluateCurve, type FigureSpec, figureSvg } from "../../src/figures/index.js";
import { checkKatexItem } from "../../src/katex.js";
import { createTopicCatalog } from "../../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LevelCalibration, LoadedKnowledge } from "../../src/knowledge/types.js";
import { Rational } from "../../src/math/rational.js";
import { createRng } from "../../src/math/rng.js";
import { variance } from "../../src/math/stats.js";
import { type Level, levels, type TopicCatalog } from "../../src/types.js";
import { verifyDraft } from "../../src/verify.js";

/** Every family added for grades 10-11 (and the two merges), with the topic that ships it. */
const UPPER: ReadonlyArray<{ family: Family; topic: string }> = [
  { family: trigRatios, topic: "precalculus/trig-ratios" },
  { family: unitCircle, topic: "precalculus/unit-circle-trig" },
  { family: conics, topic: "precalculus/conics" },
  { family: dispersion, topic: "probability-statistics/dispersion" },
  { family: combinatorics, topic: "probability-statistics/permutations-combinations" },
  { family: conditionalProbability, topic: "probability-statistics/conditional-probability" },
  { family: rateLimits, topic: "precalculus/rate-of-change-limits" },
  { family: derivatives, topic: "precalculus/derivatives" },
  { family: intervalInequality, topic: "algebra/linear-inequalities" },
  { family: functionProperties, topic: "functions/function-properties" },
];

const SEEDS = 150;

let knowledge: LoadedKnowledge;
let catalog: TopicCatalog;

beforeAll(async () => {
  knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  catalog = createTopicCatalog(knowledge);
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
    family.generate({ rng: createRng(`up-${family.id}-${level}-${seed}`), level, calibration }),
  );
}

const figureOf = (draft: ItemDraft): FigureSpec | undefined => {
  for (const line of draft.stem) {
    if (typeof line !== "string" && "figure" in line) return line.figure;
  }
  return undefined;
};

const variantsOf = (family: Family, topic: string, level: Level) =>
  new Set(drafts(family, topic, level).map((draft) => String(draft.problem.variant)));

describe("knowledge wiring", () => {
  it("ships the precalculus pack and the new topics with Spanish names and grades", () => {
    const packs = new Map(knowledge.packs.map((pack) => [pack.id, pack]));
    expect(packs.get("precalculus")?.name.es).toBe("Precálculo y cálculo");
    expect(packs.get("precalculus")?.levels).toEqual(packs.get("functions")?.levels);
    expect(
      packs
        .get("precalculus")
        ?.topics.map((topic) => topic.id)
        .sort(),
    ).toEqual([
      "conics",
      "derivatives",
      "rate-of-change-limits",
      "trig-ratios",
      "unit-circle-trig",
    ]);
    expect(knowledge.report.results).toEqual([]);
    for (const { topic } of UPPER) {
      const grades = knowledge.topics.find((entry) => entry.fullId === topic)?.grades ?? [];
      expect(
        grades.some((grade) => grade === "Décimo" || grade === "Undécimo"),
        topic,
      ).toBe(true);
    }
    const undecimo = knowledge.topics.filter((topic) => topic.grades.includes("Undécimo"));
    expect(undecimo.map((topic) => topic.id).sort()).toEqual([
      "conditional-probability",
      "derivatives",
      "permutations-combinations",
      "rate-of-change-limits",
    ]);
  });

  it("registers every family, wires it to its topic and keeps topic codes unique", () => {
    for (const { family, topic } of UPPER) {
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

  it("merges intervals into linear inequalities, keeping its original family", () => {
    const topic = knowledge.topics.find((entry) => entry.fullId === "algebra/linear-inequalities");
    expect(topic?.sources.map((source) => (source.kind === "family" ? source.family : ""))).toEqual(
      ["linear-inequality", "interval-inequality"],
    );
    expect(topic?.objectives.map((objective) => objective.id)).toEqual([
      "solve-inequality",
      "intervals",
      "absolute-value-inequalities",
    ]);
    for (const merged of ["intervals-abs-inequalities", "function-properties-linear"]) {
      expect(knowledge.topics.some((entry) => entry.id === merged)).toBe(false);
    }
  });

  it("resolves every new name to its own topic, and keeps older phrases where they were", () => {
    for (const { topic } of UPPER) {
      const name = knowledge.topics.find((entry) => entry.fullId === topic)?.name.es ?? "";
      expect(catalog.resolveTopic?.(name), name).toBe(topic);
    }
    const phrases: Record<string, string> = {
      "razón de cambio": "algebra/linear-functions",
      "valor absoluto": "basic-math/absolute-value",
      parábola: "functions/quadratic-function",
      circunferencia: "geometry/circle",
      combinaciones: "probability-statistics/counting-techniques",
      rango: "basic-math/statistics",
      "círculo unitario": "precalculus/unit-circle-trig",
      "probabilidad condicional": "probability-statistics/conditional-probability",
      "desviación estándar": "probability-statistics/dispersion",
      derivada: "precalculus/derivatives",
      "función inversa": "functions/function-properties",
      seno: "precalculus/trig-ratios",
    };
    for (const [phrase, topic] of Object.entries(phrases)) {
      expect(catalog.resolveTopic?.(phrase), phrase).toBe(topic);
    }
  });
});

describe.each(UPPER)("$family.id", ({ family, topic }) => {
  it.each(levels)(
    "level %s: verified drafts, tagged wrong distractors, valid math and figures",
    (level) => {
      const calibration = calibrationFor(topic, level);
      for (const [seed, draft] of drafts(family, topic, level).entries()) {
        const context = `${family.id}/${level}/${seed}/${String(draft.problem.variant)}`;
        expect(verifyDraft(draft, family, level, calibration), context).toEqual([]);
        const correct = draft.options.filter((option) => option.correct);
        expect(correct, context).toHaveLength(1);
        expect(correct[0]?.value, context).toBe(draft.answer.canonical);
        expect(draft.options, context).toHaveLength(4);
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
          expect(svg, context).toMatch(/<title>[^<]+<\/title>/);
          expect(svg, context).not.toMatch(/href=|<image|<script|NaN|undefined/);
          expect(svg.length, context).toBeLessThan(40_000);
        }
      }
    },
  );

  it("draws more than one kind of question at every level above basico", () => {
    for (const level of levels.slice(1)) {
      expect(variantsOf(family, topic, level).size, level).toBeGreaterThan(1);
    }
  });
});

describe("answers computed from the same parameters the figures draw", () => {
  it("trig-ratios: the drawn legs and marked angle give the ratio and the missing side", () => {
    for (const level of levels) {
      for (const draft of drafts(trigRatios, "precalculus/trig-ratios", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const params = figure.params as {
          legs: [number, number];
          sideLabels: string[];
          angleAt: "A" | "B";
          angleLabel: string;
        };
        const [horizontal, vertical] = params.legs;
        const problem = draft.problem;
        if (problem.variant === "ratio-from-sides" || problem.variant === "tan-from-legs") {
          const opp = params.angleAt === "A" ? vertical : horizontal;
          const adj = params.angleAt === "A" ? horizontal : vertical;
          expect(problem.opp).toBe(opp);
          expect(problem.adj).toBe(adj);
          const hyp = Math.hypot(horizontal, vertical);
          const value = { sin: opp / hyp, cos: adj / hyp, tan: opp / adj }[problem.fn as string];
          expect(Rational.parse(draft.answer.canonical).toNumber()).toBeCloseTo(value ?? 0, 12);
        } else {
          // missing-side and elevation: the angle at A is the labelled special angle.
          expect(params.angleAt).toBe("A");
          const degrees = Number(params.angleLabel.replace("°", ""));
          expect(Math.atan2(vertical, horizontal) * (180 / Math.PI)).toBeCloseTo(degrees, 9);
          const hidden = params.sideLabels.indexOf("x");
          const sides = [horizontal, vertical, Math.hypot(horizontal, vertical)];
          expect(surdNumber(draft.answer.canonical)).toBeCloseTo(sides[hidden] ?? 0, 9);
        }
      }
    }
    expect(trigRatios.solve({ variant: "special-value", fn: "sin", degrees: 60 })).toBe("1/2sqrt3");
    expect(trigRatios.solve({ variant: "special-value", fn: "tan", degrees: 30 })).toBe("1/3sqrt3");
    expect(missingSideText("hyp-opp", 10, 30)).toBe("5");
    expect(missingSideText("adj-opp", 6, 60)).toBe("6sqrt3");
    expect(missingSideText("opp-hyp", 4, 45)).toBe("4sqrt2");
    expect(
      String(trigRatios.solve({ variant: "find-angle", fn: "tan", first: "2sqrt3", second: "2" })),
    ).toBe("60");
  });

  it("unit-circle: the marked point is (cos θ, sin θ) and the curve has the asked period", () => {
    for (const level of levels) {
      for (const draft of drafts(unitCircle, "precalculus/unit-circle-trig", level)) {
        const figure = figureOf(draft);
        if (figure?.kind === "unit-circle") {
          const angle = Number((figure.params as { angle: number }).angle);
          expect(angle).toBe(draft.problem.degrees);
          if (draft.problem.variant === "unit-point") {
            const [x, y] = draft.answer.canonical.slice(1, -1).split(",").map(surdNumber);
            expect(x).toBeCloseTo(Math.cos((angle * Math.PI) / 180), 12);
            expect(y).toBeCloseTo(Math.sin((angle * Math.PI) / 180), 12);
          }
        }
        if (figure?.kind === "function-plot") {
          const [curve] = (figure.params as { curves: Parameters<typeof evaluateCurve>[0][] })
            .curves;
          if (curve?.type !== "sinusoid") throw new Error("expected a sinusoid");
          const { amplitude, period } = draft.problem as { amplitude: number; period: number };
          expect(curve.amplitude).toBe(amplitude);
          expect(curve.period).toBe(period);
          const peak = curve.fn === "sin" ? period / 4 : 0;
          expect(evaluateCurve(curve, peak)).toBeCloseTo(amplitude, 9);
          expect(evaluateCurve(curve, peak + period)).toBeCloseTo(amplitude, 9);
        }
      }
    }
    expect(solutionsOf("sin", "1/2")).toEqual([30, 150]);
    expect(solutionsOf("cos", "-1/2sqrt2")).toEqual([135, 225]);
    expect(unitCircle.solve({ variant: "deg-to-rad", degrees: 150 })).toBe("5/6pi");
    expect(String(unitCircle.solve({ variant: "rad-to-deg", coefficient: "7/4" }))).toBe("315");
    expect(unitCircle.solve({ variant: "quadrant", degrees: -30 })).toBe("IV");
  });

  it("conics: the grid draws the centre and radius, or the focus and directrix, of the answer", () => {
    for (const level of levels) {
      for (const draft of drafts(conics, "precalculus/conics", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const params = figure.params as Record<string, number | string>;
        if (params.shape === "circle") {
          const { h, k, r } = params as { h: number; k: number; r: number };
          expect(draft.answer.canonical).toBe(`circle(${h},${k},${r * r})`);
        } else {
          // x² = 4p y (or y² = 4p x) with the drawn p.
          const c = 4 * Number(params.p);
          expect(draft.answer.canonical).toBe(`parabola(${params.axis},${c})`);
          const svg = figureSvg(figure);
          const focus = params.axis === "horizontal" ? `F(${params.p}, 0)` : `F(0, ${params.p})`;
          expect(svg).toContain(focus.replace(".", "."));
        }
      }
    }
    expect(conics.solve({ variant: "general-center", d: -4, e: 6, f: -3 })).toBe("(2,-3)");
    expect(conics.solve({ variant: "general-radius", d: -4, e: 6, f: -3 })).toBe("4");
    expect(conics.solve({ variant: "parabola-directrix", axis: "vertical", c: 8 })).toBe("y=-2");
    expect(conics.solve({ variant: "parabola-focus", axis: "horizontal", c: -6 })).toBe("(-3/2,0)");
  });

  it("rate-limits and derivatives: the secant and the tangent pass through the marked points", () => {
    for (const level of levels) {
      for (const draft of drafts(rateLimits, "precalculus/rate-of-change-limits", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const { curves, points } = figure.params as {
          curves: Array<{ type: "polynomial"; coefficients: number[] }>;
          points: Array<{ x: number; y: number }>;
        };
        const [curve, secant] = curves;
        if (curve === undefined || secant === undefined) throw new Error("plot without curves");
        for (const point of points) {
          expect(evaluateCurve(curve, point.x)).toBeCloseTo(point.y, 9);
          expect(evaluateCurve(secant, point.x)).toBeCloseTo(point.y, 9);
        }
        expect(secant.coefficients[1]).toBe(Rational.parse(draft.answer.canonical).toNumber());
      }
      for (const draft of drafts(derivatives, "precalculus/derivatives", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const { curves, points } = figure.params as {
          curves: Array<{ type: "polynomial"; coefficients: number[] }>;
          points: Array<{ x: number; y: number }>;
        };
        const [curve, tangent] = curves;
        const [point] = points;
        if (curve === undefined || tangent === undefined || point === undefined) {
          throw new Error("plot without data");
        }
        expect(evaluateCurve(tangent, point.x)).toBeCloseTo(point.y, 9);
        expect(evaluateCurve(curve, point.x)).toBeCloseTo(point.y, 9);
        // The tangent slope equals a numeric derivative of the plotted curve.
        const h = 1e-5;
        const numeric =
          (evaluateCurve(curve, point.x + h) - evaluateCurve(curve, point.x - h)) / (2 * h);
        expect(tangent.coefficients[1] ?? 0).toBeCloseTo(numeric, 5);
        const [intercept = 0, slope = 0] = tangent.coefficients;
        expect(draft.answer.canonical).toBe(
          termsText([
            { c: Rational.of(slope), e: Rational.one },
            { c: Rational.of(intercept), e: Rational.zero },
          ]),
        );
      }
    }
    expect(String(rateLimits.solve({ variant: "limit-factor", a: 3, b: -2 }))).toBe("5");
    expect(String(rateLimits.solve({ variant: "limit-rationalize", a: 3 }))).toBe("1/6");
    expect(
      String(rateLimits.solve({ variant: "limit-infinity", top: [1, 3], bottom: [2, 0, 5] })),
    ).toBe("0");
    expect(evaluate([1, 2, 3], 2)).toBe(17);
  });

  it("derivatives: every symbolic answer matches a numeric derivative at several points", () => {
    for (const level of levels) {
      for (const draft of drafts(derivatives, "precalculus/derivatives", level)) {
        const problem = draft.problem;
        if (problem.variant !== "power-rule" && problem.variant !== "general-power") continue;
        const terms: Term[] = (problem.terms as string[]).map((entry) => {
          const [c, e] = entry.split("|");
          return { c: Rational.parse(c ?? "0"), e: Rational.parse(e ?? "0") };
        });
        const answer: Term[] =
          draft.answer.canonical === "0"
            ? []
            : draft.answer.canonical.split("+").map((entry) => {
                const [c, e] = entry.split("x^");
                return { c: Rational.parse(c ?? "0"), e: Rational.parse(e ?? "0") };
              });
        for (const x of [0.5, 1.3, 2, 3.7]) {
          const h = 1e-6;
          const numeric = (evaluateTerms(terms, x + h) - evaluateTerms(terms, x - h)) / (2 * h);
          expect(evaluateTerms(answer, x)).toBeCloseTo(numeric, 3);
        }
      }
    }
    const f: Term[] = [
      { c: Rational.of(3), e: Rational.of(-2) },
      { c: Rational.of(4), e: Rational.of(1, 2) },
    ];
    expect(termsText(derive(f))).toBe("2x^-1/2+-6x^-3");
    expect(termsLatex(derive(f))).toBe("\\dfrac{2}{\\sqrt{x}} - \\dfrac{6}{x^{3}}");
    expect(derivatives.solve({ variant: "chain-rule", a: 3, b: -1, n: 4 })).toBe(
      "chain(12,3,-1,3)",
    );
    expect(derivatives.solve({ variant: "trig-exp", sin: 2, cos: -3, exp: 1 })).toBe("trig(2,3,1)");
    expect(
      derivatives.solve({ variant: "critical-points", terms: ["1|3", "-3|2", "-9|1", "0|0"] }),
    ).toBe("{-1,3}");
  });

  it("interval-inequality: the number line draws the asked interval", () => {
    for (const level of levels) {
      for (const draft of drafts(intervalInequality, "algebra/linear-inequalities", level)) {
        const figure = figureOf(draft);
        if (figure === undefined) continue;
        const params = figure.params as { intervals: Parameters<typeof intervalText>[0] };
        expect(intervalText(params.intervals)).toBe(draft.answer.canonical);
        const svg = figureSvg(figure);
        expect(svg).toContain("Intervalo sombreado");
      }
    }
    expect(intervalInequality.solve({ variant: "abs-less", relation: "<=", c: 2, w: 3 })).toBe(
      "[-1,5]",
    );
    expect(intervalInequality.solve({ variant: "abs-greater", relation: ">", c: 0, w: 4 })).toBe(
      "(-inf,-4)U(4,inf)",
    );
    expect(
      intervalInequality.solve({
        variant: "compound",
        relation: "<",
        relation2: "<=",
        a: -3,
        b: 9,
        m: 2,
        n: 1,
      }),
    ).toBe("(-2,4]");
    expect(intervalLatex([span(null, 3, false, true)])).toBe("\\left(-\\infty, 3\\right]");
  });

  it("function-properties: the plotted vertex bounds the range", () => {
    for (const level of ["avanzado", "genio"] as const) {
      for (const draft of drafts(functionProperties, "functions/function-properties", level)) {
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
        expect(draft.answer.canonical).toMatch(
          new RegExp(`(\\[${vertex.y},inf\\))|(\\(-inf,${vertex.y}\\])`),
        );
      }
    }
    expect(functionProperties.solve({ variant: "inverse-linear", a: 2, b: 6 })).toBe(
      functionProperties.solve({ variant: "inverse-linear", a: 2, b: 6 }),
    );
    expect(
      functionProperties.solve({
        variant: "domain-combined",
        form: "root-denominator",
        a: 1,
        b: 4,
      }),
    ).toBe("[1,4)U(4,inf)");
    expect(String(functionProperties.solve({ variant: "inverse-value", a: 2, b: 3, y0: 19 }))).toBe(
      "2",
    );
    expect(
      String(functionProperties.solve({ variant: "composition-formula", b: 1, c: 2, d: 3 })),
    ).toBe(String(functionProperties.solve({ variant: "composition-formula", b: 1, c: 2, d: 3 })));
  });
});

describe("hand-checked helpers", () => {
  it("knows the exact special values, reference angles and quadrants", () => {
    const value = (fn: "sin" | "cos" | "tan", degrees: number) => {
      const exact = trigValue(fn, degrees);
      return exact === undefined ? "undefined" : exactText(exact);
    };
    expect(value("sin", 150)).toBe("1/2");
    expect(value("cos", 150)).toBe("-1/2sqrt3");
    expect(value("tan", 225)).toBe("1");
    expect(value("tan", 300)).toBe("-1sqrt3");
    expect(value("tan", 90)).toBe("undefined");
    for (let degrees = 0; degrees < 360; degrees += 15) {
      if (degrees % 30 !== 0 && degrees % 45 !== 0) continue;
      const radians = (degrees * Math.PI) / 180;
      for (const fn of ["sin", "cos"] as const) {
        expect(surdNumber(value(fn, degrees)), `${fn} ${degrees}`).toBeCloseTo(
          Math[fn](radians),
          12,
        );
      }
    }
    expect(referenceAngle(240)).toBe(60);
    expect(quadrantOf(-120)).toBe(3);
    expect(radianPlain(330)).toBe("11π/6");
    expect(radianPlain(180)).toBe("π");
  });

  it("counts, spreads and conditions exactly", () => {
    expect(choose(10, 3)).toBe(120);
    expect(String(combinatorics.solve({ variant: "anagram", n: 6, repeats: [3, 2] }))).toBe("60");
    expect(String(combinatorics.solve({ variant: "at-least-one", a: 5, b: 3, k: 3 }))).toBe("46");
    expect(String(combinatorics.solve({ variant: "handshakes", n: 6, polygon: true }))).toBe("9");
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toEqual(Rational.of(4));
    for (let seed = 0; seed < 50; seed += 1) {
      const data = wholeVarianceData(createRng(`wv-${seed}`), 5, 10, 4);
      expect(variance(data).isInteger()).toBe(true);
    }
    expect(
      String(dispersion.solve({ variant: "transform", given: "4", k: -3, ask: "var", data: [] })),
    ).toBe("36");
    expect(
      String(conditionalProbability.solve({ variant: "bayes", share: 60, da: 2, db: 4 })),
    ).toBe("3/7");
    expect(
      conditionalProbability.solve({ variant: "independence", pa: "1/2", pb: "2/5", joint: "1/5" }),
    ).toBe("yes");
  });
});

describe("conditional probability wording", () => {
  it("asks in the subjunctive after 'la probabilidad de que'", () => {
    const topic = "probability-statistics/conditional-probability";
    const stems = levels.flatMap((level) =>
      drafts(conditionalProbability, topic, level, 60).map((draft) =>
        draft.stem.filter((line): line is string => typeof line === "string").join(" "),
      ),
    );
    const asked = stems.flatMap((stem) => [...stem.matchAll(/probabilidad de que ([^?]+)\?/g)]);
    expect(asked.length).toBeGreaterThan(0);
    for (const [, clause] of asked) {
      expect(clause).not.toMatch(/\b(practica|es de|compró|pagó|llegó)\b/);
    }
  });
});
