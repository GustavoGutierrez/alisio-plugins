import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseExam } from "../src/exam.js";
import { readState } from "../src/storage.js";
// @ts-expect-error -- plain browser module without declarations.
import { draftToForm, toAnswers } from "../web/derive.js";
import { appHarness } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

afterEach(cleanup);

async function examYaml(workspace: string, folder: string) {
  return parseExam(await readFile(join(workspace, "evalua", "exams", folder, "exam.yaml"), "utf8"));
}

describe("status, catalog and doctor", () => {
  it("reports an empty workspace, then the profile, the draft and the exams", async () => {
    const h = await appHarness();
    const empty = (await h.call("status")).value;
    expect(empty).toMatchObject({ initialized: false, exams: [], activeExamId: null });
    expect(empty.locales).toEqual(["es"]);
    expect(empty.revision).toMatch(/^[0-9a-f]{24}$/);
    const examId = await h.approvedExam();
    const status = (await h.call("status")).value;
    expect(status.profile).toMatchObject({ teacherName: "Ana Perez", paper: "letter" });
    expect(status.exams).toEqual([
      expect.objectContaining({ id: examId, phase: "approved-a", active: true, number: 1 }),
    ]);
    expect(status.exams[0].docs).toEqual({ html: false, pdf: false });
  });

  it("lists catalog topics filtered by grade with localized names", async () => {
    const h = await appHarness();
    const all = (await h.call("catalog.list")).value;
    expect(all.topics.length).toBe(58);
    expect(all.packs.map((pack: { id: string }) => pack.id)).toEqual([
      "algebra",
      "basic-math",
      "functions",
      "geometry",
      "precalculus",
      "primary-math",
      "probability-statistics",
    ]);
    const sexto = (await h.call("catalog.list", { grade: "Sexto" })).value;
    expect(sexto.topics.every((t: { grades: string[] }) => t.grades.includes("Sexto"))).toBe(true);
    expect(sexto.topics.find((t: { id: string }) => t.id === "basic-math/fractions").name).toEqual({
      es: "Fracciones",
    });
    const primero = (await h.call("catalog.list", { grade: "Primero" })).value;
    expect(primero.topics.map((t: { id: string }) => t.id)).toContain("primary-math/place-value");
    expect(primero.topics.map((t: { id: string }) => t.id)).not.toContain(
      "primary-math/prism-volume",
    );
  });

  it("reports the knowledge base and the browser", async () => {
    const found = await appHarness();
    expect((await found.call("doctor")).value).toEqual({
      browser: "found",
      source: "env",
      kbOk: true,
      kbErrors: 0,
    });
    const missing = await appHarness({ printer: null });
    expect((await missing.call("doctor")).value.browser).toBe("missing");
    expect((await found.call("kb.check")).value).toEqual({ ok: true, findings: [] });
  });
});

describe("Gate A and generation", () => {
  it("approves the draft into an exam folder and generates its items", async () => {
    const h = await appHarness();
    await h.profile();
    expect((await h.call("exam.approveA")).error).toBe("phase_mismatch");
    const examId = await h.approvedExam();
    expect(examId).toBe("e01");
    const draft = await h.call("draft.get");
    expect(draft.value).toBeNull();
    const generated = await h.call("exam.generate");
    expect(generated.value).toMatchObject({ count: 10 });
    expect(generated.value.sha).toMatch(/^[0-9a-f]{64}$/);
    const items = (await h.call("items.get", { offset: 0, limit: 3 })).value;
    expect(items.total).toBe(10);
    expect(items.items).toHaveLength(3);
    expect(items.items[0].n).toBe(1);
    expect(items.items[0].stemHtml).toContain('class="katex"');
    expect(items.items[0].stemHtml).not.toContain("<script");
  });

  it("shows the draft with its blueprint and the proposed exam number", async () => {
    const h = await appHarness();
    await h.profile();
    await h.call("draft.create", {
      answers: {
        topic: "basic-math/fractions",
        grade: "septimo",
        level: "basico",
        types: ["single_choice"],
        count: "10",
        distribution: "same",
        columns: "1",
        pages: "auto",
        time: "120-pencil",
        closing: "none",
        numbering: "letters",
      },
    });
    const value = (await h.call("draft.get")).value;
    expect(value.folderNumber).toBe(1);
    expect(value.blueprint.total).toBe(10);
    expect(value.topicNames).toEqual({ "basic-math/fractions": { es: "Fracciones" } });
    expect((await h.call("draft.discard")).error).toBeUndefined();
    expect((await readState(h.workspace))?.draft).toBeUndefined();
  });
});

describe("phase guards (EVL-APP-AC-13)", () => {
  it("refuses generation before Gate A, a build before generation and Gate B before a build", async () => {
    const h = await appHarness();
    await h.profile();
    expect((await h.call("exam.generate")).error).toBe("phase_mismatch");
    const examId = await h.approvedExam();
    expect((await h.call("build.start")).error).toBe("phase_mismatch");
    expect((await h.call("exam.approveB", { examId })).error).toBe("phase_mismatch");
    await h.call("exam.generate");
    expect((await h.call("exam.approveB", { examId })).error).toBe("phase_mismatch");
    const { jobId } = (await h.call("build.start")).value;
    expect((await h.settle(jobId)).state).toBe("done");
    expect((await h.call("exam.approveB", { examId: "e09" })).error).toBe("phase_mismatch");
    expect((await h.call("exam.approveB", { examId })).value).toMatchObject({ approved: true });
    expect((await h.call("wording.save", { prompts: {} })).error).toBe("phase_mismatch");
  });

  it("asks the teacher to confirm the problems of the last build before Gate B (Q2)", async () => {
    const tooLong = async () => ({
      pdf: Buffer.from("/Type /Page /Type /Page /Type /Page /Count 3"),
      engineVersion: "Chrome/test",
    });
    const h = await appHarness({ printer: tooLong });
    await h.profile();
    await h.call("draft.create", {
      answers: {
        topic: "basic-math/integers",
        grade: "septimo",
        level: "basico",
        types: ["single_choice"],
        count: "10",
        distribution: "same",
        columns: "1",
        pages: "1",
        time: "120-pencil",
        closing: "none",
        numbering: "letters",
      },
    });
    const { examId } = (await h.call("exam.approveA")).value;
    await h.call("exam.generate");
    const job = await h.settle((await h.call("build.start")).value.jobId);
    expect(job.result.findings.map((f: { id: string }) => f.id)).toContain("EVL-LAY-001");
    expect(job.result.pdf).toBe(false);
    const ask = (await h.call("exam.approveB", { examId })).value;
    expect(ask.confirm).toBe("findings");
    expect(ask.findings[0]).toMatchObject({ id: "EVL-LAY-001", severity: "error" });
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("built");
    const ok = await h.call("exam.approveB", { examId, acknowledgeFindings: true });
    expect(ok.value).toMatchObject({ approved: true });
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("approved-b");
  });
});

describe("saving wording (EVL-APP-AC-12)", () => {
  it("applies set-prompts, re-runs generation and drops a built exam back to generated", async () => {
    const h = await appHarness();
    const examId = await h.approvedExam();
    await h.call("exam.generate");
    await h.settle((await h.call("build.start")).value.jobId);
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("built");
    const wording = (await h.call("wording.get")).value;
    const family = wording.families[0].id as string;
    expect(wording.families[0].sample).toMatch(/\$/);
    expect(wording.families[0].sampleHtml).toContain("katex");
    const saved = await h.call("wording.save", {
      prompts: { [family]: ["Resuelve paso a paso: {expr}", "sin fórmula"], ghost: ["x {expr}"] },
    });
    expect(saved.value).toMatchObject({ saved: [family], dropped: 2, regenerated: true });
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("generated");
    const folder = (await h.call("status")).value.exams[0].folder;
    expect((await examYaml(h.workspace, folder)).itemPrompts).toEqual({
      [family]: ["Resuelve paso a paso: {expr}"],
    });
    const items = JSON.parse(
      await readFile(join(h.workspace, "evalua", "exams", folder, "items.json"), "utf8"),
    ) as { items: Array<{ family: string; stem: string[] }> };
    const phrased = items.items.find((item) => item.family === family);
    expect(String(phrased?.stem[0])).toMatch(/^Resuelve paso a paso: \$/);
    // "Use the default wording": saving no templates clears them.
    const cleared = await h.call("wording.save", { prompts: {} });
    expect(cleared.value.saved).toEqual([]);
    expect((await examYaml(h.workspace, folder)).itemPrompts).toBeUndefined();
  });
});

describe("documents (EVL-APP-AC-15)", () => {
  it("serves built documents and refuses traversal, unknown exams and missing files", async () => {
    const h = await appHarness();
    const examId = await h.approvedExam();
    await h.call("exam.generate");
    const missing = await h.call("docs.get", { examId, doc: "exam", format: "pdf" });
    expect(missing.error).toBe("not_found");
    await h.settle((await h.call("build.start")).value.jobId);
    const pdf = (await h.call("docs.get", { examId, doc: "exam", format: "pdf" })).value;
    expect(pdf.mime).toBe("application/pdf");
    expect(Buffer.from(pdf.base64, "base64").toString()).toContain("/Type /Page");
    const html = (await h.call("docs.get", { examId, doc: "rubric", format: "html" })).value;
    expect(html.name).toBe("04_rubrica_calificacion.html");
    expect((await h.call("docs.get", { examId: "../e01", doc: "exam", format: "pdf" })).error).toBe(
      "invalid_input",
    );
    expect((await h.call("docs.get", { examId, doc: "../../teacher", format: "pdf" })).error).toBe(
      "invalid_input",
    );
    expect((await h.call("docs.get", { examId: "e42", doc: "exam", format: "pdf" })).error).toBe(
      "not_found",
    );
  });
});

describe("idempotency", () => {
  it("returns the first result when a mutation is retried with the same key", async () => {
    const h = await appHarness();
    await h.profile();
    const revision = (await h.call("status")).value.revision;
    const input = {
      teacherName: "Ana",
      institution: "Demo",
      subject: "Matemáticas",
      paper: "a4",
      language: "es",
      expectedRevision: revision,
    };
    const first = await h.call("profile.save", input, { idempotencyKey: "k1" });
    const again = await h.call("profile.save", input, { idempotencyKey: "k1" });
    expect(again).toEqual(first);
    const other = await h.call("profile.save", input, { idempotencyKey: "k2" });
    expect(other.error).toBe("state_changed");
  });
});

describe("archived exams (read only)", () => {
  /** e01 is archived once a second exam passes Gate A; e02 becomes the active one. */
  async function archivedExam(h: Awaited<ReturnType<typeof appHarness>>, generate: boolean) {
    const first = await h.approvedExam();
    if (generate) await h.call("exam.generate");
    await h.approvedExam("basic-math/fractions");
    return first;
  }
  it("shows the settings, the questions and the documents of an archived exam without paths", async () => {
    const h = await appHarness();
    const examId = await archivedExam(h, true);
    const status = (await h.call("status")).value;
    expect(status.activeExamId).toBe("e02");
    const folder = status.exams.find((exam: { id: string }) => exam.id === examId).folder;
    const yamlPath = join(h.workspace, "evalua", "exams", folder, "exam.yaml");
    const before = {
      yaml: await readFile(yamlPath, "utf8"),
      state: (await readState(h.workspace))?.exams[examId],
    };
    const view = (await h.call("exam.view", { examId })).value;
    expect(view.exam).toMatchObject({
      id: "e01",
      number: 1,
      grade: "Séptimo",
      level: "basico",
      questionCount: 10,
      itemTypes: { single_choice: 5, multiple_choice: 0, open: 0, practice: 5 },
      distribution: "same",
      columns: 1,
      active: false,
      phase: "generated",
      docs: { html: false, pdf: false },
    });
    expect(view.topics).toEqual([
      { id: "basic-math/integers", name: expect.objectContaining({ es: expect.any(String) }) },
    ]);
    expect(view.items.total).toBe(10);
    expect(view.items.items).toHaveLength(10);
    expect(view.items.items[0]).toMatchObject({ n: 1, type: expect.any(String) });
    expect(view.items.items[0].stemHtml).toContain('class="katex"');
    expect(view.reuse).toMatchObject({ removed: [], topicFound: true });
    expect(view.reuse.settings.topics).toEqual(["basic-math/integers"]);
    expect(JSON.stringify(view)).not.toContain(h.workspace);
    expect(JSON.stringify(view)).not.toContain("exam.yaml");
    const page = (await h.call("exam.view", { examId, offset: 8, limit: 5 })).value;
    expect(page.items.items.map((item: { n: number }) => item.n)).toEqual([9, 10]);
    // Viewing never changes the archived exam, nor the revision the frame holds.
    expect((await h.call("status")).value.revision).toBe(status.revision);
    expect({
      yaml: await readFile(yamlPath, "utf8"),
      state: (await readState(h.workspace))?.exams[examId],
    }).toEqual(before);
  });

  it("says an archived exam without generated questions has none", async () => {
    const h = await appHarness();
    const examId = await archivedExam(h, false);
    const view = (await h.call("exam.view", { examId })).value;
    expect(view.items).toEqual({ total: 0, items: [] });
    expect(view.exam.phase).toBe("approved-a");
  });

  it("refuses an unknown or malformed exam id", async () => {
    const h = await appHarness();
    await archivedExam(h, false);
    expect((await h.call("exam.view", { examId: "e42" })).error).toBe("not_found");
    expect((await h.call("exam.view", { examId: "../e01" })).error).toBe("invalid_input");
    expect((await h.call("exam.view", {})).error).toBe("invalid_input");
  });

  it("drops a type the topic no longer supports and creates a new draft from the settings", async () => {
    const h = await appHarness();
    const examId = await archivedExam(h, false);
    const status = (await h.call("status")).value;
    const folder = status.exams.find((exam: { id: string }) => exam.id === examId).folder;
    const yamlPath = join(h.workspace, "evalua", "exams", folder, "exam.yaml");
    // An exam made by an older version: multiple choice for a topic that never supported it.
    const old = (await readFile(yamlPath, "utf8")).replace(
      /itemTypes:\n(?: {2}\w+: \d+\n)+/,
      "itemTypes:\n  single_choice: 6\n  multiple_choice: 4\n  open: 0\n  practice: 0\n",
    );
    await writeFile(yamlPath, old);
    const view = (await h.call("exam.view", { examId })).value;
    expect(view.exam.itemTypes.multiple_choice).toBe(4);
    expect(view.reuse.removed).toEqual(["multiple_choice"]);
    expect(view.reuse.settings.itemTypes).toMatchObject({ single_choice: 10, multiple_choice: 0 });
    // The frame turns the settings into wizard answers; draft.create validates them as always.
    const form = draftToForm(view.reuse.settings, view.reuse.settings.grade);
    const created = (await h.call("draft.create", { answers: toAnswers(form) })).value;
    expect(created.draft).toMatchObject({
      topics: ["basic-math/integers"],
      grade: "Séptimo",
      level: "basico",
      questionCount: 10,
      itemTypes: { single_choice: 10, multiple_choice: 0 },
    });
    // A pending draft is replaced only after the teacher confirms.
    const again = (await h.call("draft.create", { answers: toAnswers(form) })).value;
    expect(again).toMatchObject({ confirm: "replace", draft: true });
    expect(await readFile(yamlPath, "utf8")).toBe(old);
    expect((await readState(h.workspace))?.activeExamId).toBe("e02");
  });
});
