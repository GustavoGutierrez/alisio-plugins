import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/clock.js";
import {
  acceptAnswers,
  buildDraft,
  buildRound,
  emptyCatalog,
  nextRound,
  parseAnswerText,
  parseTimeAnswer,
  renderPending,
  splitItemTypes,
} from "../src/interview.js";
import type { TopicCatalog } from "../src/types.js";

const catalog: TopicCatalog = {
  suggestions: (grade) =>
    grade === "Séptimo"
      ? [{ value: "basic-math/rational-numbers", label: "Números racionales" }]
      : [{ value: "basic-math/fractions", label: "Fracciones" }],
  packs: () => [
    { value: "basic-math", label: "Matemática básica" },
    { value: "algebra", label: "Álgebra" },
  ],
  resolvePack: (topic) => (topic.startsWith("basic-math/") ? "basic-math" : undefined),
};

function check(questions: ReturnType<typeof buildRound>) {
  expect(questions.length).toBeGreaterThan(0);
  expect(questions.length).toBeLessThanOrEqual(4);
  for (const question of questions) {
    expect(question.options.length, question.id).toBeGreaterThanOrEqual(2);
    expect(question.options.length, question.id).toBeLessThanOrEqual(4);
    expect(question.options.filter((option) => option.recommended).length, question.id).toBe(1);
  }
}

describe("profile round", () => {
  it("asks the four profile questions in one round", () => {
    const questions = buildRound("profile", { answers: {}, catalog: emptyCatalog });
    expect(questions.map((q) => q.id)).toEqual(["teacher_name", "institution", "logo", "subject"]);
    check(questions);
  });

  it("skips answered questions", () => {
    const questions = buildRound("profile", {
      answers: { teacher_name: "enter", "teacher_name:text": "Ana" },
      catalog: emptyCatalog,
    });
    expect(questions.map((q) => q.id)).toEqual(["institution", "logo", "subject"]);
  });

  it("edit mode preselects current values with a recommended keep option", () => {
    const questions = buildRound("profile", {
      answers: {},
      catalog: emptyCatalog,
      current: {
        teacherName: "Ana",
        institution: "Demo",
        subject: "Matemáticas",
        logo: "assets/logo.png",
      },
    });
    check(questions);
    expect(questions[0]?.options[0]).toMatchObject({ value: "keep", recommended: true });
    expect(questions[0]?.options[0]?.label).toContain("Ana");
  });
});

describe("exam rounds", () => {
  it("round 1 asks topic, grade, level; kind only when packs are ambiguous", () => {
    const none = buildRound("1", { answers: {}, catalog: emptyCatalog });
    expect(none.map((q) => q.id)).toEqual(["topic", "grade", "level"]);
    check(none);
    const withKb = buildRound("1", { answers: {}, catalog });
    expect(withKb.map((q) => q.id)).toEqual(["topic", "grade", "level", "kind"]);
    check(withKb);
    const resolved = buildRound("1", {
      answers: { topic: "basic-math/fractions" },
      catalog,
    });
    expect(resolved.map((q) => q.id)).toEqual(["grade", "level"]);
  });

  it("offers topic suggestions after the grade is known", () => {
    const questions = buildRound("1", { answers: { grade: "Séptimo" }, catalog });
    const topic = questions.find((q) => q.id === "topic");
    expect(topic?.options.some((o) => o.value === "basic-math/rational-numbers")).toBe(true);
    expect(topic?.options.some((o) => o.textInput)).toBe(true);
    check(questions);
  });

  it("round 2 asks types, count, distribution, columns (max 4)", () => {
    const questions = buildRound("2", { answers: {}, catalog: emptyCatalog });
    expect(questions.map((q) => q.id)).toEqual(["types", "count", "distribution", "columns"]);
    expect(questions[0]?.multiSelect).toBe(true);
    check(questions);
  });

  it("does not ask same/bank for a single question", () => {
    const questions = buildRound("2", {
      answers: { count: "other", "count:text": "1" },
      catalog: emptyCatalog,
    });
    expect(questions.map((q) => q.id)).toEqual(["types", "columns"]);
  });

  it("asks the bank follow-up only for bank distribution", () => {
    expect(
      nextRound({
        profileMissing: false,
        answers: { distribution: "same" },
        completed: ["1", "2"],
      }),
    ).toBe("3");
    expect(
      nextRound({
        profileMissing: false,
        answers: { distribution: "bank", count: "10" },
        completed: ["1", "2"],
      }),
    ).toBe("2b");
    const questions = buildRound("2b", { answers: { count: "10" }, catalog: emptyCatalog });
    expect(questions.map((q) => q.id)).toEqual(["bank_size", "variants"]);
    check(questions);
    expect(questions[0]?.options[0]?.label).toContain("30");
  });

  it("round 3 asks pages, time, closing", () => {
    const questions = buildRound("3", { answers: {}, catalog: emptyCatalog });
    expect(questions.map((q) => q.id)).toEqual(["pages", "time", "closing"]);
    check(questions);
  });
});

describe("round sequence", () => {
  it("runs the profile round only when the profile is missing", () => {
    expect(nextRound({ profileMissing: true, answers: {}, completed: [] })).toBe("profile");
    expect(nextRound({ profileMissing: false, answers: {}, completed: [] })).toBe("1");
    expect(nextRound({ profileMissing: false, answers: {}, completed: ["1"] })).toBe("2");
    expect(
      nextRound({ profileMissing: false, answers: {}, completed: ["1", "2", "3"] }),
    ).toBeUndefined();
  });
});

describe("answers", () => {
  const questions = buildRound("1", { answers: {}, catalog: emptyCatalog });

  it("accepts option values and free text", () => {
    const { accepted, errors } = acceptAnswers(questions, {
      level: "intermedio",
      grade: "other",
      "grade:text": "Décimo",
      topic: "enter",
      "topic:text": "Fracciones",
    });
    expect(errors).toEqual([]);
    expect(accepted).toMatchObject({
      level: "intermedio",
      grade: "other",
      "grade:text": "Décimo",
      topic: "enter",
      "topic:text": "Fracciones",
    });
  });

  it("treats a bare value on a text-capable question as free text", () => {
    const { accepted, errors } = acceptAnswers(questions, { topic: "Ecuaciones lineales" });
    expect(errors).toEqual([]);
    expect(accepted).toMatchObject({ topic: "enter", "topic:text": "Ecuaciones lineales" });
  });

  it("reports unknown ids, bad values, text on closed options and missing text", () => {
    const { errors } = acceptAnswers(questions, {
      nope: "x",
      level: "dificil",
      "grade:text": "Décimo",
      topic: "enter",
    });
    expect(errors.join("\n")).toMatch(/Unknown question id: nope/);
    expect(errors.join("\n")).toMatch(/level: "dificil" is not allowed/);
    expect(errors.join("\n")).toMatch(/grade:text was given without grade/);
    expect(errors.join("\n")).toMatch(/topic: option "enter" needs free text/);
  });

  it("rejects control characters and overlong text", () => {
    const { errors } = acceptAnswers(questions, { topic: "enter", "topic:text": `a${"\u0007"}b` });
    expect(errors.join("\n")).toMatch(/printable/);
  });

  it("treats the stop option as no answer", () => {
    const { accepted, errors } = acceptAnswers(questions, { topic: "stop" });
    expect(accepted).toEqual({});
    expect(errors).toEqual([]);
  });

  it("validates multi-select lists", () => {
    const round2 = buildRound("2", { answers: {}, catalog: emptyCatalog });
    expect(acceptAnswers(round2, { types: "single_choice,practice" }).accepted.types).toBe(
      "single_choice,practice",
    );
    expect(acceptAnswers(round2, { types: "single_choice,wat" }).errors.join()).toMatch(
      /not allowed/,
    );
    expect(acceptAnswers(round2, { types: "" }).accepted.types).toBeUndefined();
  });

  it("parses id=value text and JSON", () => {
    const ids = ["topic", "grade", "level"];
    expect(parseAnswerText("topic=enter topic:text=Fracciones y mas grade=septimo", ids)).toEqual({
      topic: "enter",
      "topic:text": "Fracciones y mas",
      grade: "septimo",
    });
    expect(parseAnswerText('{"level":"basico"}', ids)).toEqual({ level: "basico" });
    expect(parseAnswerText("just words", ids)).toBeUndefined();
    expect(() => parseAnswerText("{bad", ids)).toThrow(/JSON/);
  });

  it("renders pending questions with ids, options and an example", () => {
    const text = renderPending({ round: "1", createdAt: "x", questions }, "/evalua:new");
    expect(text).toContain("topic:");
    expect(text).toContain("(recommended)");
    expect(text).toContain("Example: /evalua:new");
  });
});

describe("time answers", () => {
  it("parses presets and free text", () => {
    expect(parseTimeAnswer("120-pencil")).toEqual({
      durationMinutes: 120,
      instrument: "pencil",
      calculator: false,
    });
    expect(parseTimeAnswer("60-pen")).toEqual({
      durationMinutes: 60,
      instrument: "pen",
      calculator: false,
    });
    expect(parseTimeAnswer("90 pen calculator")).toEqual({
      durationMinutes: 90,
      instrument: "pen",
      calculator: true,
    });
    expect(parseTimeAnswer("45")).toEqual({
      durationMinutes: 45,
      instrument: "any",
      calculator: false,
    });
    expect(parseTimeAnswer("lápiz 30 sin calculadora")).toEqual({
      durationMinutes: 30,
      instrument: "pencil",
      calculator: false,
    });
    expect(parseTimeAnswer("soon")).toBeUndefined();
    expect(parseTimeAnswer("2")).toBeUndefined();
  });
});

describe("item type split", () => {
  it("splits proportionally with weights 2/1/2/1 and sums to the count", () => {
    expect(splitItemTypes(10, ["single_choice"])).toEqual({
      single_choice: 10,
      multiple_choice: 0,
      open: 0,
      practice: 0,
    });
    const split = splitItemTypes(10, ["single_choice", "multiple_choice", "open", "practice"]);
    expect(split).toEqual({ single_choice: 3, multiple_choice: 2, open: 2, practice: 3 });
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(10);
    for (const count of [1, 2, 7, 13, 25]) {
      const result = splitItemTypes(count, ["single_choice", "practice", "open"]);
      expect(Object.values(result).reduce((a, b) => a + b, 0)).toBe(count);
    }
  });
});

describe("draft", () => {
  const profile = {
    schemaVersion: 1 as const,
    teacherName: "Ana",
    institution: "Demo",
    subject: "Matemáticas",
    language: "es",
    paper: "letter" as const,
  };
  const answers = {
    topic: "enter",
    "topic:text": "Conjunto de los números racionales (Q)",
    grade: "septimo",
    level: "basico",
    types: "single_choice,practice",
    count: "10",
    distribution: "same",
    columns: "1",
    pages: "auto",
    time: "120-pencil",
    closing: "none",
  };

  it("builds an exam draft with title, theme, slug, year and defaults", () => {
    const draft = buildDraft(
      answers,
      profile,
      fixedClock("2026-10-06T00:00:00.000Z"),
      emptyCatalog,
    );
    expect(draft).toMatchObject({
      schemaVersion: 1,
      title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
      theme: "CONJUNTO DE LOS NÚMEROS RACIONALES (Q)",
      grade: "Séptimo",
      level: "basico",
      questionCount: 10,
      distribution: "same",
      columns: 1,
      maxPages: "auto",
      durationMinutes: 120,
      instrument: "pencil",
      calculator: false,
      schoolYear: 2026,
      status: "draft",
      closing: { kind: "none", pinned: null },
      slug: "conjunto-de-los-numeros-racionales-q-septimo",
      itemTypes: { single_choice: 5, multiple_choice: 0, open: 0, practice: 5 },
    });
    expect(draft.bank).toBeUndefined();
  });

  it("includes bank settings only for bank distribution and a numeric page limit", () => {
    const draft = buildDraft(
      {
        ...answers,
        distribution: "bank",
        bank_size: "default",
        variants: "3",
        pages: "other",
        "pages:text": "2",
        columns: "2",
        closing: "quote",
      },
      profile,
      fixedClock("2026-01-01T00:00:00.000Z"),
      emptyCatalog,
    );
    expect(draft.bank).toEqual({ size: 30, variants: 3 });
    expect(draft.maxPages).toBe(2);
    expect(draft.columns).toBe(2);
    expect(draft.closing.kind).toBe("quote");
  });

  it("uses a free-text grade and the profile subject", () => {
    const draft = buildDraft(
      { ...answers, grade: "other", "grade:text": "Décimo" },
      { ...profile, subject: "Álgebra" },
      fixedClock("2026-01-01T00:00:00.000Z"),
      emptyCatalog,
    );
    expect(draft.grade).toBe("Décimo");
    expect(draft.title).toBe("EVALUACIÓN DE ÁLGEBRA - GRADO DÉCIMO");
  });
});
