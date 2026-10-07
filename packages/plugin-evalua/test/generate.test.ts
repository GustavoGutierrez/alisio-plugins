import { beforeAll, describe, expect, it } from "vitest";
import { type Blueprint, blueprintTotal, buildBlueprint } from "../src/blueprint.js";
import { verifyExam } from "../src/checks.js";
import { families, familyIds } from "../src/families/index.js";
import { applyPrompts, type ExamItem, type GenerateResult, generateExam } from "../src/generate.js";
import { shippedKnowledgeDir } from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import type { LevelCalibration, LoadedTopic } from "../src/knowledge/types.js";
import { createRng } from "../src/math/rng.js";
import { canonicalJson } from "../src/storage.js";
import type { ItemType } from "../src/types.js";
import { verifyDraft, verifyItem } from "../src/verify.js";

const emptyTypes = (): Record<ItemType, number> => ({
  single_choice: 0,
  multiple_choice: 0,
  open: 0,
  practice: 0,
});

let calibration: LevelCalibration;
let topics: LoadedTopic[];

const makeBlueprint = (
  itemTypes: Record<ItemType, number>,
  topicList = ["basic-math/integers"],
): Blueprint => buildBlueprint({ topics: topicList, level: "basico", calibration, itemTypes });

const generate = (blueprint: Blueprint, seed: string): GenerateResult =>
  generateExam({ blueprint, topics, level: "basico", calibration, seed });

beforeAll(async () => {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  const pack = knowledge.packs.find((entry) => entry.id === "basic-math");
  if (!pack) throw new Error("basic-math pack missing");
  calibration = pack.levels.basico;
  topics = knowledge.topics;
});

describe("blueprint", () => {
  it("sums to the requested total and is deterministic", () => {
    const input = {
      topics: ["basic-math/integers", "basic-math/fractions"],
      level: "basico" as const,
      calibration,
      itemTypes: { ...emptyTypes(), single_choice: 10 },
    };
    const first = buildBlueprint(input);
    const second = buildBlueprint(input);
    expect(blueprintTotal(first)).toBe(10);
    expect(first.cells.map((cell) => `${cell.topic}|${cell.cognitive}|${cell.type}`)).toEqual(
      second.cells.map((cell) => `${cell.topic}|${cell.cognitive}|${cell.type}`),
    );
    for (const cell of first.cells) expect(input.topics).toContain(cell.topic);
  });

  it("spreads a type across topics and the cognitive mix", () => {
    const blueprint = buildBlueprint({
      topics: ["basic-math/integers", "basic-math/fractions"],
      level: "basico" as const,
      calibration,
      itemTypes: { ...emptyTypes(), single_choice: 4, practice: 4 },
    });
    expect(blueprintTotal(blueprint)).toBe(8);
    const types = new Set(blueprint.cells.map((cell) => cell.type));
    expect(types).toEqual(new Set(["single_choice", "practice"]));
  });
});

describe("generateExam", () => {
  it("freezes the requested number of items with unique references", () => {
    const result = generate(makeBlueprint({ ...emptyTypes(), single_choice: 6 }), "e01");
    expect(result.findings).toEqual([]);
    expect(result.items).toHaveLength(6);
    const refs = result.items.map((item) => item.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const item of result.items) {
      expect(item.options.filter((option) => option.correct)).toHaveLength(1);
      expect(item.ref).toMatch(/^[A-Z]{2,4}-[0-9A-F]{4,6}$/);
    }
  });

  it("is deterministic for a seed and differs for another", () => {
    const blueprint = makeBlueprint({ ...emptyTypes(), single_choice: 6 });
    const a = generate(blueprint, "e01");
    const b = generate(blueprint, "e01");
    const c = generate(blueprint, "e02");
    expect(canonicalJson(a.items)).toBe(canonicalJson(b.items));
    expect(canonicalJson(a.items)).not.toBe(canonicalJson(c.items));
  });

  it("reports EVL-ITM-009 when no source can fill a type", () => {
    const result = generate(makeBlueprint({ ...emptyTypes(), multiple_choice: 2 }), "e01");
    expect(result.findings.map((finding) => finding.id)).toContain("EVL-ITM-009");
  });

  it("adapts a family core to open items", () => {
    const result = generate(makeBlueprint({ ...emptyTypes(), open: 3 }), "e03");
    expect(result.findings).toEqual([]);
    expect(result.items).toHaveLength(3);
    for (const item of result.items) expect(item.options).toEqual([]);
  });
});

describe("applyPrompts", () => {
  it("overrides the instruction with an agent template and keeps the math", () => {
    const family = families["fraction-simplify"];
    if (!family) throw new Error("fraction-simplify missing");
    const draft = family.generate({ rng: createRng("x"), level: "basico", calibration });
    const overridden = applyPrompts(
      draft,
      ["Reduce {expr} a su forma irreducible."],
      createRng("y"),
    );
    expect(overridden.stem[0]).toMatch(/^Reduce /);
    expect(overridden.stem[0]).toMatch(/\$/);
    expect(overridden.answer).toEqual(draft.answer);
    expect(applyPrompts(draft, [], createRng("y"))).toBe(draft);
  });
});

describe("verifyExam (EVL-EXM)", () => {
  const setup = () => {
    const blueprint = makeBlueprint({ ...emptyTypes(), single_choice: 4 });
    return { blueprint, generated: generate(blueprint, "e04") };
  };

  it("passes a consistent exam", () => {
    const { blueprint, generated } = setup();
    const findings = verifyExam({
      items: generated.items,
      blueprint,
      questionCount: 4,
      itemTypes: { ...emptyTypes(), single_choice: 4 },
      mode: "same",
    });
    expect(findings).toEqual([]);
  });

  it("flags a duplicated reference and a wrong item count", () => {
    const { blueprint, generated } = setup();
    const first = generated.items[0];
    if (!first) throw new Error("missing item");
    const broken: ExamItem[] = [first, { ...first }];
    const findings = verifyExam({
      items: broken,
      blueprint,
      questionCount: 4,
      itemTypes: { ...emptyTypes(), single_choice: 4 },
      mode: "same",
    });
    expect(findings.map((finding) => finding.id)).toContain("EVL-EXM-002");
  });

  it("flags a type count that does not sum to questionCount", () => {
    const { blueprint, generated } = setup();
    const findings = verifyExam({
      items: generated.items,
      blueprint,
      questionCount: 9,
      itemTypes: { ...emptyTypes(), single_choice: 4 },
      mode: "same",
    });
    expect(findings.map((finding) => finding.id)).toContain("EVL-EXM-001");
  });

  it("flags a list that differs from the frozen ids", () => {
    const { blueprint, generated } = setup();
    const findings = verifyExam({
      items: generated.items,
      blueprint,
      questionCount: 4,
      itemTypes: { ...emptyTypes(), single_choice: 4 },
      mode: "same",
      frozenIds: ["other"],
    });
    expect(findings.map((finding) => finding.id)).toContain("EVL-EXM-003");
  });
});

describe("verifyDraft and verifyItem (EVL-ITM)", () => {
  it("accepts a healthy draft and detects tampered ones", () => {
    const family = families["integer-ops"];
    if (!family) throw new Error("integer-ops missing");
    const draft = family.generate({ rng: createRng("verify"), level: "basico", calibration });
    expect(verifyDraft(draft, family, "basico", calibration)).toEqual([]);

    const wrongKey = { ...draft, answer: { ...draft.answer, canonical: "999999" } };
    expect(verifyDraft(wrongKey, family, "basico", calibration).map((f) => f.id)).toContain(
      "EVL-ITM-004",
    );
    const firstOption = draft.options[0];
    if (!firstOption) throw new Error("missing option");
    const equivalent = {
      ...draft,
      options: draft.options.map((option, index) =>
        index === 1 ? { ...option, value: firstOption.value } : option,
      ),
    };
    expect(verifyDraft(equivalent, family, "basico", calibration).map((f) => f.id)).toContain(
      "EVL-ITM-003",
    );
    const forbidden = {
      ...draft,
      options: draft.options.map((option, index) =>
        index === 1 ? { ...option, display: "ninguna de las anteriores" } : option,
      ),
    };
    expect(verifyDraft(forbidden, family, "basico", calibration).map((f) => f.id)).toContain(
      "EVL-ITM-007",
    );
    const outOfRange = { ...draft, numericValues: [9999] };
    expect(verifyDraft(outOfRange, family, "basico", calibration).map((f) => f.id)).toContain(
      "EVL-ITM-006",
    );
  });

  it("checks frozen items structurally", () => {
    const good: ExamItem = {
      id: "x",
      ref: "INT-0001",
      topic: "basic-math/integers",
      family: "integer-ops",
      source: "generator",
      type: "single_choice",
      level: "basico",
      cognitive: "apply",
      stem: ["$1 + 1$"],
      options: [
        { key: "A", value: "2", display: "$2$", correct: true, error: "none" },
        { key: "B", value: "3", display: "$3$", correct: false, error: "off-by-one" },
      ],
      answer: { canonical: "2", display: "$2$" },
      solution: ["$1 + 1 = 2$"],
      points: 1,
      estimatedSeconds: 60,
      check: { kind: "recomputed", verifiedBy: "integer-ops" },
    };
    expect(verifyItem(good)).toEqual([]);
    const noCorrect: ExamItem = {
      ...good,
      options: good.options.map((option) => ({ ...option, correct: false })),
    };
    expect(verifyItem(noCorrect).map((f) => f.id)).toContain("EVL-ITM-001");
  });
});
