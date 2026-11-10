import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { capacityErrors, runWizard, type WizardAnswers } from "../src/app/wizard.js";
import { buildBlueprint } from "../src/blueprint.js";
import { capacityShortfalls, shortfallsFromFindings } from "../src/capacity.js";
import { fixedClock } from "../src/clock.js";
import { factoring, factoringRootPairs } from "../src/families/factoring.js";
import { familyIds } from "../src/families/index.js";
import { generateExam } from "../src/generate.js";
import { emptyCatalog, offeredItemTypes } from "../src/interview.js";
import { createTopicCatalog } from "../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import type { LoadedKnowledge } from "../src/knowledge/types.js";
import { createRng } from "../src/math/rng.js";
import { readState } from "../src/storage.js";
import {
  type ItemType,
  itemTypes,
  type Level,
  levels,
  type TeacherProfile,
  type TopicCatalog,
} from "../src/types.js";
import { verifyDraft } from "../src/verify.js";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup, harness, PROFILE_ANSWERS, ROUND3 } from "./helpers/harness.js";

afterEach(cleanup);

/** The largest question count the wizard and the chat offer as a preset (10, 15, 20). */
const MAX_PRESET = 20;
const SEEDS = ["e01", "e02", "e03"];

let knowledge: LoadedKnowledge;
let catalog: TopicCatalog;

beforeAll(async () => {
  knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  catalog = createTopicCatalog(knowledge);
});

const calibrationOf = (topicId: string, level: Level) => {
  const topic = knowledge.topics.find((entry) => entry.fullId === topicId);
  const pack = knowledge.packs.find((entry) => entry.id === topic?.packId);
  const calibration = pack?.levels[level];
  if (!calibration) throw new Error(`no calibration for ${topicId}/${level}`);
  return calibration;
};

const only = (type: ItemType, count: number) =>
  Object.fromEntries(itemTypes.map((entry) => [entry, entry === type ? count : 0])) as Record<
    ItemType,
    number
  >;

function fill(topic: string, type: ItemType, level: Level, count: number, seed = "e01") {
  const calibration = calibrationOf(topic, level);
  const blueprint = buildBlueprint({
    topics: [topic],
    level,
    calibration,
    itemTypes: only(type, count),
  });
  return generateExam({ blueprint, topics: knowledge.topics, level, calibration, seed });
}

describe("factoring capacity", () => {
  it.each(levels)(
    "level %s offers well over the largest preset count of distinct trinomials",
    (level) => {
      const calibration = calibrationOf("algebra/factoring", level);
      // Count + 5 is the smallest bank the wizard accepts; the old bound of 3 gave only 12.
      expect(factoringRootPairs(calibration.coefficientRange).length).toBeGreaterThanOrEqual(
        MAX_PRESET + 5,
      );
      for (const type of ["single_choice", "practice"] as const) {
        const result = fill("algebra/factoring", type, level, MAX_PRESET + 5);
        expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
        expect(result.items).toHaveLength(MAX_PRESET + 5);
      }
    },
  );

  it.each(levels)("level %s keeps every drawn trinomial verifiable", (level) => {
    const calibration = calibrationOf("algebra/factoring", level);
    for (let seed = 0; seed < 60; seed += 1) {
      const draft = factoring.generate({
        rng: createRng(`fac-${level}-${seed}`),
        level,
        calibration,
      });
      expect(verifyDraft(draft, factoring, level, calibration), `${level}/${seed}`).toEqual([]);
    }
  });
});

describe("every shipped topic x supported type x level", () => {
  it("fills the largest preset count, or the capacity check rejects it before generation", () => {
    const short: string[] = [];
    for (const topic of knowledge.topics) {
      const offered = catalog.topic?.(topic.fullId);
      for (const type of itemTypes.filter((entry) => offered?.supports[entry])) {
        for (const level of levels) {
          const shortfalls = capacityShortfalls({
            topics: [topic.fullId],
            level,
            calibration: calibrationOf(topic.fullId, level),
            itemTypes: only(type, MAX_PRESET),
            knowledge: knowledge.topics,
            seeds: SEEDS,
          });
          if (shortfalls.length === 0) {
            for (const seed of SEEDS) {
              const result = fill(topic.fullId, type, level, MAX_PRESET, seed);
              expect(result.items, `${topic.fullId}/${type}/${level}/${seed}`).toHaveLength(
                MAX_PRESET,
              );
            }
          } else {
            const errors = capacityErrors(shortfalls);
            expect(errors.every((error) => error.code === "capacity")).toBe(true);
            expect(shortfalls[0]).toMatchObject({ topic: topic.fullId, type });
            short.push(topic.fullId);
          }
        }
      }
    }
    // Only the bank-only place-value topic (no matching family exists) is short today.
    expect([...new Set(short)]).toEqual(["basic-math/natural-numbers"]);
  }, 120_000);

  it("wires the powers-roots family into the basic-math topic, keeping its bank", () => {
    const topic = knowledge.topics.find((entry) => entry.fullId === "basic-math/powers-roots");
    expect(topic?.sources.map((source) => source.kind)).toEqual(["family", "bank"]);
    expect(
      fill("basic-math/powers-roots", "single_choice", "basico", MAX_PRESET).items,
    ).toHaveLength(MAX_PRESET);
  });

  it("treats a generator that throws as a rejected candidate, never a crashed exam", () => {
    // polynomial-ops cannot always build four distinct options; the whole run used to throw.
    expect(() => fill("algebra/polynomials", "multiple_choice", "basico", 15)).not.toThrow();
  });
});

describe("capacity shortfalls", () => {
  it("names the topic, type, requested and available counts", () => {
    const shortfalls = capacityShortfalls({
      topics: ["basic-math/natural-numbers"],
      level: "basico",
      calibration: calibrationOf("basic-math/natural-numbers", "basico"),
      itemTypes: only("single_choice", 10),
      knowledge: knowledge.topics,
      seeds: SEEDS,
    });
    expect(shortfalls).toEqual([
      {
        topic: "basic-math/natural-numbers",
        name: { es: "Números naturales y valor posicional" },
        type: "single_choice",
        requested: 10,
        available: 2,
      },
    ]);
    expect(capacityErrors(shortfalls)).toEqual([
      { field: "count", code: "capacity", capacity: shortfalls },
    ]);
    expect(
      capacityErrors([{ ...(shortfalls[0] as (typeof shortfalls)[0]), available: 0 }]),
    ).toEqual([expect.objectContaining({ field: "types", code: "capacity" })]);
  });

  it("maps blocked-generation slot findings back to the blueprint", () => {
    const result = fill("algebra/factoring", "single_choice", "basico", 45);
    const blueprint = buildBlueprint({
      topics: ["algebra/factoring"],
      level: "basico",
      calibration: calibrationOf("algebra/factoring", "basico"),
      itemTypes: only("single_choice", 45),
    });
    const mapped = shortfallsFromFindings(result.findings, blueprint.cells, knowledge.topics);
    expect(mapped).toEqual([
      {
        topic: "algebra/factoring",
        name: { es: "Factorización" },
        type: "single_choice",
        requested: 45,
        available: result.items.length,
      },
    ]);
  });
});

describe("item types offered per topic", () => {
  it("offers only a topic's supported types, and never multiple_choice for a shipped topic", () => {
    expect(offeredItemTypes({ answers: { topic: "algebra/factoring" }, catalog })).toEqual([
      "single_choice",
      "practice",
    ]);
    expect(offeredItemTypes({ answers: { topic: "basic-math/natural-numbers" }, catalog })).toEqual(
      ["single_choice", "open"],
    );
    for (const topic of knowledge.topics) {
      expect(offeredItemTypes({ answers: { topic: topic.fullId }, catalog })).not.toContain(
        "multiple_choice",
      );
    }
    expect(offeredItemTypes({ answers: {}, catalog: emptyCatalog })).toEqual([...itemTypes]);
  });

  it("makes the app wizard refuse a type the topic does not support", () => {
    const profile: TeacherProfile = {
      schemaVersion: 1,
      teacherName: "Ana Perez",
      institution: "Demo",
      subject: "Matemáticas",
      language: "es",
      paper: "letter",
    };
    const answers: WizardAnswers = {
      topic: "algebra/factoring",
      grade: "octavo",
      level: "basico",
      types: ["single_choice", "multiple_choice"],
      count: "10",
      distribution: "same",
      columns: "1",
      pages: "auto",
      time: "120-pencil",
      closing: "none",
      numbering: "letters",
    };
    const context = { catalog, profile, clock: fixedClock("2026-10-06T12:00:00.000Z") };
    expect(runWizard(answers, context)).toEqual({ errors: [{ field: "types", code: "invalid" }] });
    expect("draft" in runWizard({ ...answers, types: ["single_choice"] }, context)).toBe(true);
  });
});

describe("capacity guard before generation", () => {
  const answers = (topic: string, count: string): WizardAnswers => ({
    topic,
    grade: "sexto",
    level: "basico",
    types: ["single_choice"],
    count,
    distribution: "same",
    columns: "1",
    pages: "auto",
    time: "120-pencil",
    closing: "none",
    numbering: "letters",
  });

  it("refuses an app draft whose questions cannot be created, leaving the state untouched", async () => {
    const h = await appHarness();
    await h.profile();
    const before = await readState(h.workspace);
    const result = await h.call("draft.create", {
      answers: answers("basic-math/natural-numbers", "10"),
      replace: false,
    });
    expect(result.value?.errors).toEqual([
      {
        field: "count",
        code: "capacity",
        capacity: [
          expect.objectContaining({
            topic: "basic-math/natural-numbers",
            type: "single_choice",
            requested: 10,
            available: 2,
          }),
        ],
      },
    ]);
    expect(await readState(h.workspace)).toEqual(before);
    const fits = await h.call("draft.create", {
      answers: answers("algebra/factoring", "20"),
      replace: false,
    });
    expect(fits.value?.draft?.topics).toEqual(["algebra/factoring"]);
  });

  it("re-asks the chat's question count instead of recording a dead draft", async () => {
    const chat = await harness({
      answers: [
        PROFILE_ANSWERS,
        { topic: "basic-math/natural-numbers", grade: "sexto", level: "basico" },
        { types: ["single_choice"], count: "10", distribution: "same", columns: "1" },
        ROUND3,
      ],
    });
    const text = await chat.run("new");
    expect(text).toContain('count: the topic "Números naturales y valor posicional" has only 2');
    const state = await readState(chat.workspace);
    expect(state?.draft).toBeUndefined();
    expect(state?.interview?.pending?.round).toBe("2");
    expect(state?.interview?.pending?.questions.map((question) => question.id)).toEqual(["count"]);
  });
});
