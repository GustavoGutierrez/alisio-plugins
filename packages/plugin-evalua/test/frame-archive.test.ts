import { afterAll, describe, expect, it } from "vitest";
import { CATALOG, frameEnv, type Reply, statusWith } from "./helpers/frame-env.js";

/** e02 is the active exam; e01 is archived (read only). */
const archived = (docs = { html: false, pdf: false }) => ({
  id: "e01",
  number: 1,
  folder: "01-fracciones-septimo",
  title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
  theme: "FRACCIONES",
  grade: "Séptimo",
  level: "basico",
  questionCount: 10,
  phase: "approved-a",
  gates: {},
  active: false,
  docs,
});
const statusOf = (docs?: { html: boolean; pdf: boolean }) => {
  const base = statusWith("approved-a");
  const active = { ...base.exams[0], id: "e02", number: 2, theme: "ECUACIONES" };
  return { ...base, exams: [active, archived(docs)], activeExamId: "e02" };
};
const SETTINGS = {
  topics: ["basic-math/fractions"],
  grade: "Séptimo",
  level: "intermedio",
  itemTypes: { single_choice: 10, multiple_choice: 0, open: 0, practice: 0 },
  questionCount: 10,
  distribution: "same",
  columns: 2,
  numbering: "letters",
  maxPages: "auto",
  durationMinutes: 90,
  instrument: "pencil",
  calculator: false,
  closing: { kind: "none", pinned: null },
};
const viewOf = (items: unknown[], docs = { html: false, pdf: false }) => ({
  exam: {
    ...archived(docs),
    itemTypes: { single_choice: 6, multiple_choice: 4, open: 0, practice: 0 },
    distribution: "same",
    columns: 2,
    numbering: "letters",
    maxPages: "auto",
    durationMinutes: 90,
    instrument: "pencil",
    calculator: false,
    closing: { kind: "none", pinned: null },
    schoolYear: 2026,
  },
  topics: [{ id: "basic-math/fractions", name: { es: "Fracciones", en: "Fractions" } }],
  items: { total: items.length, items },
  reuse: { settings: SETTINGS, removed: ["multiple_choice"], topicFound: true },
});
const ITEM = {
  n: 1,
  type: "single_choice",
  family: "fraction-ops",
  stemHtml: "<p>Calcula 1/2 + 1/4</p>",
  options: [
    { key: "a", html: "3/4", correct: true },
    { key: "b", html: "2/6", correct: false },
  ],
  answerHtml: "3/4",
};
const DRAFT = {
  title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
  theme: "FRACCIONES",
  grade: "Séptimo",
  level: "intermedio",
  topics: ["basic-math/fractions"],
  itemTypes: { single_choice: 10, multiple_choice: 0, open: 0, practice: 0 },
  questionCount: 10,
  distribution: "same",
  columns: 2,
  numbering: "letters",
  maxPages: "auto",
  durationMinutes: 90,
  instrument: "pencil",
  calculator: false,
  closing: { kind: "none", pinned: null },
  schoolYear: 2026,
};

describe("archived exam view", () => {
  let env: Awaited<ReturnType<typeof frameEnv>>;
  afterAll(() => env?.close());

  it("shows what an archived exam holds and reuses its settings for a new exam", async () => {
    env = await frameEnv("en");
    const { window, doc, requests, wait, click } = env;
    let current = { status: statusOf(), view: viewOf([]) };
    let createCalls = 0;
    env.setResponder((request): Reply => {
      switch (request.action) {
        case "status":
          return { value: current.status };
        case "exam.view":
          return { value: current.view };
        case "catalog.list":
          return { value: CATALOG };
        case "docs.get":
          return {
            value: {
              name: "01_examen_estudiante.html",
              mime: "text/html",
              base64: Buffer.from("<html><body><p>Examen</p></body></html>").toString("base64"),
            },
          };
        case "draft.create":
          createCalls += 1;
          return createCalls === 1
            ? { value: { confirm: "replace", chatInterview: false, draft: true, revision: "r1" } }
            : { value: { draft: DRAFT, revision: "r2" } };
        case "draft.get":
          return {
            value: { draft: DRAFT, blueprint: null, topicNames: {}, folderNumber: 3 },
          };
        default:
          return { value: null };
      }
    });
    env.connect(env.host, window.parent, "en");
    await env.loaded;
    await wait(() => !!doc.querySelector('[data-action="open-exam"][data-id="e01"]'));

    // An archived exam that never got questions or documents: its settings, and what to do next.
    click('[data-action="open-exam"][data-id="e01"]');
    await wait(() => !!doc.querySelector(".archive-summary"));
    expect(requests.find((r) => r.action === "exam.view")?.input).toEqual({ examId: "e01" });
    const text = doc.querySelector("main")?.textContent ?? "";
    expect(text).toContain(
      "This exam is archived: you can view it and download its documents. To change it or create its questions again, use its settings for a new exam.",
    );
    expect(text).not.toContain("Only the newest exam can change.");
    const summary = doc.querySelector(".archive-summary")?.textContent ?? "";
    expect(summary).toContain("Fractions");
    expect(summary).toContain("7th grade");
    expect(summary).toContain("Basic");
    expect(summary).toContain("Multiple choice, one answer 6");
    expect(summary).toContain("Multiple choice, several answers 4");
    expect(summary).toContain("10");
    expect(doc.querySelector("#archive-questions")?.textContent).toContain(
      "No questions were created for this exam.",
    );
    expect(doc.querySelector("#archive-documents")?.textContent).toContain(
      "This exam has no documents.",
    );
    // Read only: no edit controls of the active exam.
    expect(doc.querySelector("#generate, #build, #approve-b, #save-wording")).toBeNull();
    expect(doc.querySelector("#reuse-exam")?.textContent).toContain(
      "Use these settings for a new exam",
    );
    expect(doc.querySelector('#archive-home[data-action="home"]')?.textContent).toContain(
      "Back to home",
    );

    // Back home, then an archived exam with questions and documents.
    click("#archive-home");
    await wait(() => !!doc.querySelector("#new-exam"));
    current = {
      status: statusOf({ html: true, pdf: false }),
      view: viewOf([ITEM], { html: true, pdf: false }),
    };
    click('[data-action="open-exam"][data-id="e01"]');
    await wait(() => !!doc.querySelector("#archive-questions li.item"));
    expect(doc.querySelector("#archive-questions .stem")?.innerHTML).toContain("Calcula 1/2 + 1/4");
    expect(doc.querySelectorAll("#archive-questions .options li")).toHaveLength(2);
    expect(doc.querySelector("#archive-questions .answer")).toBeNull();
    (doc.querySelector("#show-answers") as HTMLInputElement).click();
    await wait(() => !!doc.querySelector("#archive-questions .answer"));
    expect(doc.querySelector("#archive-documents #viewer")).not.toBeNull();
    await wait(() => requests.some((r) => r.action === "docs.get"));
    expect(requests.find((r) => r.action === "docs.get")?.input).toMatchObject({ examId: "e01" });

    // Reusing the settings: the wizard answers come from the archived exam (types filtered),
    // the existing replace confirmation runs, and the review tells which type was removed.
    click("#reuse-exam");
    await wait(() => (doc.querySelector("#dialog") as HTMLDialogElement).open);
    expect(requests.find((r) => r.action === "draft.create")?.input).toMatchObject({
      answers: {
        topic: "basic-math/fractions",
        grade: "septimo",
        level: "intermedio",
        types: ["single_choice"],
        count: "10",
        columns: "2",
        time: "90-pencil",
      },
      replace: false,
    });
    click('#dialog [data-action="dialog-ok"]');
    await wait(() => !!doc.querySelector("#approve-a"));
    expect(requests.filter((r) => r.action === "draft.create").at(-1)?.input).toMatchObject({
      replace: true,
    });
    expect(doc.querySelector("main")?.textContent).toContain(
      "This topic no longer supports “Multiple choice, several answers”, so it was removed.",
    );
    expect(requests.filter((r) => r.action === "draft.create")).toHaveLength(2);
  }, 30_000);
});
