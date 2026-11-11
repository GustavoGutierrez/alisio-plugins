import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reuseSettings, runWizard, type WizardAnswers } from "../src/app/wizard.js";
import { fixedClock } from "../src/clock.js";
import { familyIds } from "../src/families/index.js";
import { createTopicCatalog } from "../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import { readState } from "../src/storage.js";
import type { TeacherProfile, TopicCatalog } from "../src/types.js";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup, harness, PROFILE_ANSWERS, ROUND2, ROUND3 } from "./helpers/harness.js";

afterEach(cleanup);

let catalog: TopicCatalog;
const profile: TeacherProfile = {
  schemaVersion: 1,
  teacherName: "Ana Perez",
  institution: "Instituto Cristiano Demo",
  subject: "Matemáticas",
  language: "es",
  paper: "letter",
};
const clock = fixedClock("2026-10-06T12:00:00.000Z");

beforeAll(async () => {
  catalog = createTopicCatalog(
    await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds }),
  );
});

const base = (topic: string): WizardAnswers => ({
  topic,
  grade: "septimo",
  level: "basico",
  types: ["single_choice", "practice"],
  count: "10",
  distribution: "same",
  columns: "1",
  pages: "auto",
  time: "120-pencil",
  closing: "none",
  numbering: "letters",
});

describe("wizard answers to a draft (EVL-APP-AC-06)", () => {
  it("builds the same ExamDraft as the chat interview for the same answers", async () => {
    const topic = catalog.suggestions("Séptimo")[0]?.value as string;
    const chat = await harness({
      answers: [PROFILE_ANSWERS, { topic, grade: "septimo", level: "basico" }, ROUND2, ROUND3],
    });
    await chat.run("new");
    const chatDraft = (await readState(chat.workspace))?.draft;
    const result = runWizard(base(topic), { catalog, profile, clock });
    expect("draft" in result).toBe(true);
    if (!("draft" in result) || !chatDraft) throw new Error("no draft");
    const { createdAt: _a, ...app } = result.draft;
    const { createdAt: _b, ...fromChat } = chatDraft;
    expect(app).toEqual(fromChat);
  });

  it("titles a topic outside the first suggestions with its catalog name, never its id", () => {
    const result = runWizard(
      {
        ...base("basic-math/powers-roots"),
        // Powers and roots supports single-choice and open questions, not practice.
        types: ["single_choice", "open"],
        grade: "other",
        "grade:text": "Noveno",
      },
      { catalog, profile, clock },
    );
    if (!("draft" in result)) throw new Error(JSON.stringify(result));
    expect(result.draft.topics).toEqual(["basic-math/powers-roots"]);
    expect(result.draft.theme).not.toContain("/");
    expect(result.draft.theme).toBe(result.draft.theme.toLocaleUpperCase("es"));
    expect(result.draft.topicText).toBeNull();
    expect(result.draft.grade).toBe("Noveno");
  });

  it("asks the bank questions only for a bank and keeps their values", () => {
    const result = runWizard(
      {
        ...base("basic-math/fractions"),
        distribution: "bank",
        bank_size: "other",
        "bank_size:text": "40",
        variants: "3",
      },
      { catalog, profile, clock },
    );
    if (!("draft" in result)) throw new Error(JSON.stringify(result));
    expect(result.draft.bank).toEqual({ size: 40, variants: 3 });
    const same = runWizard(
      { ...base("basic-math/fractions"), bank_size: "other", "bank_size:text": "1" },
      { catalog, profile, clock },
    );
    expect("draft" in same ? same.draft.bank : "errors").toBeUndefined();
  });
});

describe("invalid wizard answers (EVL-APP-AC-07)", () => {
  it("returns field errors for every bad answer", () => {
    const fields = (answers: WizardAnswers) => {
      const result = runWizard(answers, { catalog, profile, clock });
      return "errors" in result ? result.errors : [];
    };
    const topic = "basic-math/fractions";
    expect(fields({ ...base(topic), count: "other", "count:text": "0" })).toEqual([
      { field: "count", code: "invalid" },
    ]);
    expect(
      fields({
        ...base(topic),
        distribution: "bank",
        bank_size: "other",
        "bank_size:text": "12",
        variants: "2",
      }),
    ).toEqual([{ field: "bank_size", code: "too_small" }]);
    expect(
      fields({
        ...base(topic),
        distribution: "bank",
        bank_size: "default",
        variants: "other",
        "variants:text": "9",
      }),
    ).toEqual([{ field: "variants", code: "invalid" }]);
    expect(fields({ ...base(topic), time: "other", "time:text": "abc" })).toEqual([
      { field: "time", code: "invalid" },
    ]);
    expect(fields(base("basic-math/not-a-topic"))).toEqual([
      { field: "topic", code: "not_in_catalog" },
    ]);
    expect(fields({ ...base(topic), level: undefined })).toEqual([
      { field: "level", code: "required" },
    ]);
  });

  it("leaves the workspace untouched when the answers are invalid", async () => {
    const h = await appHarness();
    await h.profile();
    const before = await readState(h.workspace);
    const result = await h.call("draft.create", {
      answers: { ...base("basic-math/fractions"), count: "other", "count:text": "0" },
      replace: false,
    });
    expect(result.value?.errors).toEqual([{ field: "count", code: "invalid" }]);
    expect(await readState(h.workspace)).toEqual(before);
  });
});

describe("replacing a pending chat interview (EVL-APP-AC-08)", () => {
  it("asks to confirm, then replaces the chat interview with the app draft", async () => {
    const h = await appHarness({ interactive: false });
    await h.profile();
    await h.chat.run("new");
    expect((await readState(h.workspace))?.interview?.pending?.round).toBe("1");
    const answers = base("basic-math/fractions");
    const ask = await h.call("draft.create", { answers, replace: false });
    expect(ask.value).toMatchObject({ confirm: "replace" });
    expect((await readState(h.workspace))?.draft).toBeUndefined();
    const done = await h.call("draft.create", { answers, replace: true });
    expect(done.value).toMatchObject({ draft: { topics: ["basic-math/fractions"] } });
    const state = await readState(h.workspace);
    expect(state?.interview).toBeUndefined();
    expect(state?.draft?.topics).toEqual(["basic-math/fractions"]);
  });
});

describe("reusing an archived exam's settings", () => {
  const spec = (itemTypes: Record<string, number>, topic = "basic-math/integers") => {
    const result = runWizard(base(topic), { catalog, profile, clock });
    if (!("draft" in result)) throw new Error(JSON.stringify(result));
    return {
      ...result.draft,
      distribution: "bank" as const,
      bank: { size: 30, variants: 3 },
      columns: 2 as const,
      numbering: "section" as const,
      maxPages: 3,
      durationMinutes: 45,
      instrument: "pen" as const,
      calculator: true,
      closing: { kind: "quote" as const, pinned: null },
      itemTypes: { single_choice: 0, multiple_choice: 0, open: 0, practice: 0, ...itemTypes },
    };
  };

  it("keeps every wizard setting of a spec whose types the topic still supports", () => {
    const reuse = reuseSettings(spec({ single_choice: 6, practice: 4 }), catalog);
    expect(reuse.removed).toEqual([]);
    expect(reuse.topicFound).toBe(true);
    expect(reuse.settings).toEqual({
      topics: ["basic-math/integers"],
      grade: "Séptimo",
      level: "basico",
      itemTypes: { single_choice: 6, multiple_choice: 0, open: 0, practice: 4 },
      questionCount: 10,
      distribution: "bank",
      bank: { size: 30, variants: 3 },
      columns: 2,
      numbering: "section",
      maxPages: 3,
      durationMinutes: 45,
      instrument: "pen",
      calculator: true,
      closing: { kind: "quote", pinned: null },
    });
  });

  it("drops a type the topic no longer supports and moves its questions to a supported one", () => {
    // Integers supports single choice and practice, not multiple choice.
    const reuse = reuseSettings(spec({ single_choice: 6, multiple_choice: 4 }), catalog);
    expect(reuse.removed).toEqual(["multiple_choice"]);
    expect(reuse.settings.itemTypes).toEqual({
      single_choice: 10,
      multiple_choice: 0,
      open: 0,
      practice: 0,
    });
    expect(reuse.settings.questionCount).toBe(10);
  });

  it("falls back to a supported type when none of the old types is left", () => {
    const reuse = reuseSettings(spec({ multiple_choice: 10 }), catalog);
    expect(reuse.removed).toEqual(["multiple_choice"]);
    expect(reuse.settings.itemTypes).toEqual({
      single_choice: 10,
      multiple_choice: 0,
      open: 0,
      practice: 0,
    });
  });

  it("says when the topic is no longer in the catalog", () => {
    const reuse = reuseSettings(
      { ...spec({ single_choice: 10 }), topics: ["gone/topic"] },
      catalog,
    );
    expect(reuse.topicFound).toBe(false);
    expect(reuse.settings.topics).toEqual(["gone/topic"]);
  });
});
