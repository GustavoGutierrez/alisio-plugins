import { describe, expect, it } from "vitest";
import { runWizard } from "../src/app/wizard.js";
import { fixedClock } from "../src/clock.js";
import { familyIds } from "../src/families/index.js";
import { createTopicCatalog } from "../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import {
  buildProgress,
  checkLogo,
  documentsState,
  draftToForm,
  emptyForm,
  examStepState,
  filterTopics,
  fromEditable,
  generationNotices,
  gradeAnswer,
  gradeList,
  missingFields,
  nextExamStep,
  offeredTypes,
  promptsToSave,
  responseError,
  templateParts,
  templateProblem,
  toAnswers,
  toEditable,
  wizardSteps,
  wordingState,
  // @ts-expect-error -- plain browser module without declarations.
} from "../web/derive.js";

describe("wizard view state (EVL-APP-AC-22)", () => {
  it("shows the bank step only for a bank of more than one question", () => {
    const form = emptyForm();
    expect(wizardSteps(form)).toEqual(["topic", "questions", "format"]);
    expect(wizardSteps({ ...form, distribution: "bank" })).toEqual([
      "topic",
      "questions",
      "bank",
      "format",
    ]);
    expect(wizardSteps({ ...form, distribution: "bank", count: "other", countText: "1" })).toEqual([
      "topic",
      "questions",
      "format",
    ]);
  });

  it("serializes other options as <id>:text and grades outside the chat's list as grade:text", () => {
    const form = {
      ...emptyForm(),
      grade: "Noveno",
      topic: "algebra/x",
      level: "basico",
      types: ["open"],
      count: "other",
      countText: " 12 ",
      distribution: "bank",
      bankSize: "other",
      bankText: "40",
      variants: "other",
      variantsText: "4",
      pages: "other",
      pagesText: "3",
      time: "other",
      minutes: "75",
      instrument: "pen",
      calculator: true,
    };
    expect(toAnswers(form)).toEqual({
      topic: "algebra/x",
      grade: "other",
      "grade:text": "Noveno",
      level: "basico",
      types: ["open"],
      count: "other",
      "count:text": "12",
      distribution: "bank",
      columns: "1",
      bank_size: "other",
      "bank_size:text": "40",
      variants: "other",
      "variants:text": "4",
      pages: "other",
      "pages:text": "3",
      time: "other",
      "time:text": "75 pen calculator",
      closing: "none",
      numbering: "letters",
    });
    expect(gradeAnswer("Séptimo")).toEqual({ grade: "septimo" });
    expect(toAnswers({ ...form, distribution: "same" }).bank_size).toBeUndefined();
  });

  it("produces answers the backend wizard accepts, and reads a draft back into the form", async () => {
    const catalog = createTopicCatalog(
      await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds }),
    );
    const form = {
      ...emptyForm(),
      grade: "Octavo",
      topic: "basic-math/percentages",
      level: "avanzado",
      // Only types the topic supports: percentages has no open questions.
      types: ["single_choice", "practice"],
      count: "15",
      distribution: "bank",
      bankSize: "double",
      variants: "3",
      time: "other",
      minutes: "50",
      instrument: "any",
      calculator: false,
      closing: "quote",
      numbering: "section",
    };
    const result = runWizard(toAnswers(form), {
      catalog,
      profile: {
        schemaVersion: 1,
        teacherName: "A",
        institution: "B",
        subject: "Matemáticas",
        language: "es",
        paper: "letter",
      },
      clock: fixedClock("2026-10-06T12:00:00.000Z"),
    });
    if (!("draft" in result)) throw new Error(JSON.stringify(result));
    expect(result.draft).toMatchObject({
      grade: "Octavo",
      durationMinutes: 50,
      instrument: "any",
      calculator: false,
      bank: { size: 30, variants: 3 },
    });
    const back = draftToForm(result.draft, "Octavo");
    expect(toAnswers(back)).toEqual(toAnswers(form));
  });

  it("lists grades in school order and filters topics by grade and accent-free search", () => {
    const topics = [
      { id: "a", name: { es: "Fracciones" }, pack: "basic-math", grades: ["Séptimo", "Sexto"] },
      { id: "b", name: { es: "Ecuaciones lineales" }, pack: "algebra", grades: ["Noveno"] },
    ];
    expect(gradeList(topics)).toEqual(["Sexto", "Séptimo", "Noveno"]);
    expect(filterTopics(topics, { grade: "Sexto" }).map((t: { id: string }) => t.id)).toEqual([
      "a",
    ]);
    expect(filterTopics(topics, { query: "ecuacion" }).map((t: { id: string }) => t.id)).toEqual([
      "b",
    ]);
    expect(filterTopics(topics, { query: "FRACCIÓN" })).toHaveLength(1);
    expect(filterTopics(topics, { query: "decimal" })).toEqual([]);
    expect(filterTopics(topics, { query: "fracc" })).toHaveLength(1);
    expect(missingFields(emptyForm(), "topic")).toEqual(["grade", "topic", "level"]);
    expect(missingFields({ ...emptyForm(), count: "other" }, "questions")).toEqual([
      "types",
      "count",
    ]);
  });
});

describe("exam view state (EVL-APP-AC-22)", () => {
  it("maps each phase to the next step and to the steps that can be opened", () => {
    expect(nextExamStep("approved-a")).toBe("wording");
    expect(nextExamStep("generated")).toBe("documents");
    expect(nextExamStep("built")).toBe("approve");
    expect(examStepState("approved-a")).toEqual({
      wording: true,
      questions: true,
      documents: false,
      approve: false,
    });
    expect(examStepState("approved-b")).toEqual({
      wording: false,
      questions: true,
      documents: true,
      approve: true,
    });
  });

  it("turns drafting off without a model and keeps the rest of the wording step", () => {
    expect(wordingState({ models: { available: false }, phase: "approved-a" })).toEqual({
      canDraft: false,
      noModel: true,
      drafting: false,
      locked: false,
    });
    expect(wordingState({ models: { available: true }, phase: "generated" }).canDraft).toBe(true);
    expect(wordingState({ models: { available: true }, phase: "approved-b" }).locked).toBe(true);
  });

  it("shows the no-browser state and the last build's findings on the documents step", () => {
    const exam = { phase: "built", docs: { html: true, pdf: false } };
    const state = documentsState({
      exam,
      lastBuild: { pdf: false, findings: [{ id: "EVL-LAY-000", severity: "warning" }] },
      doctor: { browser: "missing" },
    });
    expect(state).toMatchObject({ canBuild: true, hasPdf: false, hasHtml: true, noBrowser: true });
    expect(state.errors).toEqual([]);
    expect(documentsState({ exam: { phase: "approved-a" } }).canBuild).toBe(false);
    expect(buildProgress({ phase: "fit", step: 2, total: 9 })).toEqual({
      key: "fitting",
      args: [3, 5],
      percent: 22,
    });
    expect(buildProgress({ phase: "print", step: 6, total: 9 })).toEqual({
      key: "printing",
      args: [2, 4],
      percent: 67,
    });
  });

  it("edits templates with a visible math marker and checks them like the backend", () => {
    const markers = ["the math goes here", "aquí va la fórmula"];
    expect(toEditable("Calcula {expr}.", markers[1])).toBe("Calcula [aquí va la fórmula].");
    expect(fromEditable("Calcula [the math goes here] y [aquí va la fórmula]", markers)).toBe(
      "Calcula {expr} y {expr}",
    );
    expect(templateProblem("Calcula")).toBe("needsMath");
    expect(templateProblem("Calcula <b>{expr}</b>")).toBe("invalid");
    expect(templateProblem("Calcula {expr}")).toBeNull();
    expect(templateParts("A {expr} B")).toEqual([{ text: "A " }, { math: true }, { text: " B" }]);
    expect(
      promptsToSave(
        [
          { id: "x", templates: ["Saved {expr}"] },
          { id: "y", templates: ["Old {expr}"] },
        ],
        { y: [] },
      ),
    ).toEqual({ x: ["Saved {expr}"] });
  });

  it("checks the logo in the frame and names the permission a denial is about", () => {
    expect(checkLogo({ size: 10, type: "image/png" })).toBeNull();
    expect(checkLogo({ size: 2 * 1024 * 1024 + 1, type: "image/png" })).toBe("file_too_large");
    expect(checkLogo({ size: 10, type: "image/svg+xml" })).toBe("bad_image");
    expect(responseError({ error: "not_permitted", effect: "process" }, "write")).toBe(
      "not_permitted_process",
    );
    expect(responseError({ error: "not_permitted" }, "process")).toBe("not_permitted_process");
    expect(responseError({ error: "not_permitted" }, "write")).toBe("not_permitted_write");
    expect(responseError({ result: { error: "busy" } }, "write")).toBe("busy");
    expect(responseError({ result: { value: 1 } }, "read")).toBeNull();
  });
});

describe("item types and capacity notices", () => {
  const topics = [
    {
      id: "algebra/factoring",
      supports: { single_choice: true, multiple_choice: false, open: false, practice: true },
    },
    {
      id: "basic-math/natural-numbers",
      supports: { single_choice: true, multiple_choice: false, open: true, practice: false },
    },
  ];

  it("offers only the chosen topic's supported types, like the chat's round 2", () => {
    expect(offeredTypes(topics, "algebra/factoring")).toEqual(["single_choice", "practice"]);
    expect(offeredTypes(topics, undefined)).toEqual(["single_choice", "open", "practice"]);
    expect(offeredTypes([], "x")).toEqual(["single_choice", "multiple_choice", "open", "practice"]);
  });

  it("turns slot findings into one plain notice per topic and type, keeping the raw codes", () => {
    const findings = [
      {
        id: "EVL-ITM-009",
        subject: "algebra/factoring single_choice",
        message: "slot could not be filled within 50 attempts",
      },
      {
        id: "EVL-EXM-002",
        subject: "exam",
        message: "the exam has 12 items, not the consecutive 1..15",
      },
      { id: "EVL-EXM-004", subject: "algebra/factoring", message: "cell mismatch" },
    ];
    const capacity = [
      {
        topic: "algebra/factoring",
        name: { es: "Factorización" },
        type: "single_choice",
        requested: 15,
        available: 12,
      },
    ];
    const notices = generationNotices({ findings, capacity });
    expect(notices.capacity).toEqual([{ ...capacity[0], kind: "few" }]);
    expect(notices.others.map((finding: { id: string }) => finding.id)).toEqual(["EVL-EXM-004"]);
    expect(notices.technical).toEqual(findings);
    expect(generationNotices({ findings }).others).toEqual(findings);
    expect(generationNotices(undefined).technical).toEqual([]);
  });
});
