import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPrefs } from "../src/app/prefs.js";
import {
  buildWordingPrompt,
  buildWordingRetry,
  MAX_TEMPLATE_CHARS,
  MAX_TEMPLATES,
  parseWordingOutput,
  validateTemplates,
  WORDING_MAX_TOKENS,
} from "../src/app/wording.js";
import { parseExam, stringifyExam } from "../src/exam.js";
import { readState } from "../src/storage.js";
import { appHarness, MODEL } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

const allowed = ["integer-ops", "fraction-ops"];

describe("wording parser (EVL-APP-AC-10)", () => {
  it("keeps only valid templates and counts the dropped ones", () => {
    const long = `Calcula ${"x".repeat(MAX_TEMPLATE_CHARS)} {expr}`;
    const output = [
      "Here are the templates you asked for:",
      "```json",
      JSON.stringify({
        "integer-ops": [
          "Calcula el resultado de {expr}.",
          "Resuelve sin calculadora",
          "Calcula $x$ en {expr}",
          "Calcula <b>{expr}</b>",
          long,
          "Halla el valor de {expr}.",
        ],
        "fraction-ops": ["1 {expr}", "2 {expr}", "3 {expr}", "4 {expr}", "5 {expr}", "6 {expr}"],
        "made-up": ["Calcula {expr}"],
      }),
      "```",
      "Hope this helps!",
    ].join("\n");
    const result = parseWordingOutput(output, allowed);
    expect(result.templates).toEqual({
      "integer-ops": ["Calcula el resultado de {expr}.", "Halla el valor de {expr}."],
      "fraction-ops": ["1 {expr}", "2 {expr}", "3 {expr}", "4 {expr}", "5 {expr}"],
    });
    // 4 invalid integer-ops entries, 1 extra fraction-ops entry, 1 unknown family entry.
    expect(result.dropped).toBe(6);
    expect(result.valid).toBe(true);
    expect(MAX_TEMPLATES).toBe(5);
  });

  it("returns nothing for output that is not a JSON object", () => {
    expect(parseWordingOutput("I cannot help with that.", allowed)).toEqual({
      templates: {},
      dropped: 0,
      valid: false,
    });
    expect(parseWordingOutput('["a {expr}"]', allowed).valid).toBe(false);
  });

  it("applies the same rules to the teacher's own text", () => {
    const result = validateTemplates(
      { "integer-ops": ["  Calcula {expr}  ", "", "sin math"], unknown: ["x {expr}"] },
      allowed,
    );
    expect(result.templates).toEqual({ "integer-ops": ["Calcula {expr}"] });
    expect(result.dropped).toBe(2);
    expect(validateTemplates({ "integer-ops": ["tab\there {expr}"] }, allowed).dropped).toBe(1);
  });
});

describe("wording prompt", () => {
  it("states the role, language, grade, level, JSON shape and the data boundary", () => {
    const prompt = buildWordingPrompt({
      language: "es",
      grade: "Séptimo",
      level: "basico",
      families: [{ id: "integer-ops", sample: "Calcula: $-3+5$" }],
    });
    expect(prompt.system).toMatch(/school math teacher/i);
    expect(prompt.system).toContain("Spanish");
    expect(prompt.system).toContain("Séptimo");
    expect(prompt.system).toContain("basico");
    expect(prompt.system).toContain("{expr}");
    expect(prompt.system).toMatch(/data/i);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.text).toContain("integer-ops");
    expect(prompt.messages[0]?.text).toContain("Calcula: $-3+5$");
    expect(prompt.maxTokens).toBe(4000);
    expect(WORDING_MAX_TOKENS).toBe(4000);
  });

  it("builds one retry that shows the previous answer and repeats the strict rules", () => {
    const prompt = buildWordingPrompt({
      language: "es",
      grade: "Séptimo",
      level: "basico",
      families: [{ id: "integer-ops", sample: "Calcula: $-3+5$" }],
    });
    const retry = buildWordingRetry(prompt, "Claro, aquí va", "unreadable");
    expect(retry.system).toBe(prompt.system);
    expect(retry.maxTokens).toBe(prompt.maxTokens);
    expect(retry.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(retry.messages[1]?.text).toBe("Claro, aquí va");
    expect(retry.messages[2]?.text).toMatch(/only the JSON object/i);
    expect(retry.messages[2]?.text).toContain("{expr}");
    const rejected = buildWordingRetry(prompt, "x".repeat(10_000), "rejected");
    expect(rejected.messages[1]?.text.length).toBeLessThanOrEqual(4000);
    expect(rejected.messages[2]?.text).toMatch(/\{expr\}/);
    // An empty previous answer is not sent as an assistant turn.
    expect(buildWordingRetry(prompt, "  ", "unreadable").messages.map((m) => m.role)).toEqual([
      "user",
      "user",
    ]);
  });
});

describe("robust wording parser", () => {
  const good = { "integer-ops": ["Calcula {expr}."] };

  it("skips prose that mentions {expr} before the JSON object", () => {
    const output = `Each sentence keeps {expr} where the math goes, as asked:\n${JSON.stringify(good)}`;
    expect(parseWordingOutput(output, allowed)).toMatchObject({ templates: good, valid: true });
  });

  it("ignores a think block, even one that holds braces or a draft object", () => {
    const output = `<think>The user wants {expr}. Draft: {"integer-ops": ["Halla {expr}"]}</think>\n${JSON.stringify(good)}`;
    expect(parseWordingOutput(output, allowed).templates).toEqual(good);
    const thinking = `<thinking>{ not json }</thinking>${JSON.stringify(good)}`;
    expect(parseWordingOutput(thinking, allowed).templates).toEqual(good);
  });

  it("prefers a fenced json block and ignores trailing text with braces", () => {
    const output = [
      "Here it is:",
      "```json",
      JSON.stringify(good),
      "```",
      "Note: keep {expr} and {this} in mind.",
    ].join("\n");
    expect(parseWordingOutput(output, allowed).templates).toEqual(good);
    const trailing = `${JSON.stringify(good)}\nThat is all } really.`;
    expect(parseWordingOutput(trailing, allowed).templates).toEqual(good);
  });

  it("respects braces and escaped quotes inside JSON strings", () => {
    const output = `{"integer-ops": ["Calcula \\"esto\\" } {expr}"]}`;
    expect(parseWordingOutput(output, allowed).templates).toEqual({
      "integer-ops": ['Calcula "esto" } {expr}'],
    });
  });

  it("prefers an object with an allowed family over another plain object", () => {
    const output = `{"note": "first"} then ${JSON.stringify(good)}`;
    expect(parseWordingOutput(output, allowed).templates).toEqual(good);
    // Without any allowed key the first plain object is used (its entries are dropped).
    expect(parseWordingOutput('{"ghost": ["x {expr}"]}', allowed)).toEqual({
      templates: {},
      dropped: 1,
      valid: true,
    });
  });

  it("reports truncated output as unreadable", () => {
    expect(parseWordingOutput('{"integer-ops": ["Calcula {expr}", "Hal', allowed).valid).toBe(
      false,
    );
  });

  it("normalises placeholder variants to {expr}", () => {
    const output = JSON.stringify({
      "integer-ops": ["Calcula { expr }.", "Halla {EXPR}.", "Resuelve {{expr}}."],
    });
    expect(parseWordingOutput(output, allowed).templates).toEqual({
      "integer-ops": ["Calcula {expr}.", "Halla {expr}.", "Resuelve {expr}."],
    });
  });

  it("turns a single $…$ formula into {expr} and drops two of them", () => {
    const output = JSON.stringify({
      "integer-ops": ["Calcula $-3+5$.", "Compara $2$ y $3$."],
      "fraction-ops": ["Simplifica $\\frac{2}{4}$ al máximo."],
    });
    const result = parseWordingOutput(output, allowed);
    expect(result.templates).toEqual({
      "integer-ops": ["Calcula {expr}."],
      "fraction-ops": ["Simplifica {expr} al máximo."],
    });
    expect(result.dropped).toBe(1);
  });

  it("still rejects markup, control characters and long sentences", () => {
    const output = JSON.stringify({
      "integer-ops": [
        "<script>alert(1)</script> {expr}",
        "Calcula <img src=x onerror=alert(1)> {expr}",
        "tab\there {expr}",
        `Calcula ${"x".repeat(MAX_TEMPLATE_CHARS)} {expr}`,
        "Calcula {expr} > 0",
        "Calcula {expr}.",
        "Calcula {expr}.",
      ],
    });
    const result = parseWordingOutput(output, allowed);
    expect(result.templates).toEqual({ "integer-ops": ["Calcula {expr}."] });
    expect(result.dropped).toBe(6);
  });
});

afterEach(cleanup);

/** A model that drafts one template for every family it is asked about. */
const drafting = async (request: { messages: Array<{ text: string }> }) => {
  const ids = [...(request.messages[0]?.text ?? "").matchAll(/^- ([a-z0-9-]+):/gm)].map(
    (match) => match[1] as string,
  );
  return `Sure!\n${JSON.stringify(Object.fromEntries(ids.map((id) => [id, [`Calcula con cuidado: {expr}`]])))}`;
};

describe("model choice for the wording (EVL-APP-AC-11)", () => {
  it("passes the chosen model when it resolves and stores the draft until it is saved", async () => {
    const h = await appHarness({ complete: drafting });
    await h.approvedExam();
    const listed = (await h.call("models.list")).value;
    expect(listed).toEqual({
      models: [{ reference: MODEL.reference, label: "Teacher One", provider: "Acme" }],
      chosen: null,
      available: true,
    });
    expect((await h.call("models.choose", { reference: "acme/nope" })).error).toBe("invalid_input");
    expect((await h.call("models.choose", { reference: MODEL.reference })).value).toMatchObject({
      chosen: MODEL.reference,
    });
    const job = await h.settle((await h.call("wording.draft")).value.jobId);
    expect(job.state).toBe("done");
    expect(job.result.fallback).toBe(false);
    expect(h.completions[0]?.model).toBe(MODEL.reference);
    expect(h.completions[0]?.sessionId).toBeUndefined();
    const wording = (await h.call("wording.get")).value;
    expect(wording.families[0].draft).toEqual(["Calcula con cuidado: {expr}"]);
    // Never applied until the teacher saves it.
    expect(wording.families[0].templates).toEqual([]);
  });

  it("falls back to the session's model when the chosen one no longer resolves", async () => {
    let known = true;
    const h = await appHarness({
      complete: drafting,
      resolve: async (reference) => {
        if (!known) throw new Error("gone");
        return { ...MODEL, reference };
      },
    });
    await h.approvedExam();
    await h.call("models.choose", { reference: MODEL.reference });
    known = false;
    const job = await h.settle((await h.call("wording.draft")).value.jobId);
    expect(job.result.fallback).toBe(true);
    expect(h.completions[0]?.model).toBeUndefined();
    expect(h.completions[0]?.sessionId).toBe("parent");
    expect((await readPrefs(h.workspace)).wording.e01?.fallback).toBe(true);
  });

  it("refuses drafting without models while every other step keeps working", async () => {
    const h = await appHarness({ models: [] });
    await h.approvedExam();
    expect((await h.call("models.list")).value.available).toBe(false);
    expect((await h.call("wording.draft")).error).toBe("no_model");
    const family = (await h.call("wording.get")).value.families[0].id;
    expect(
      (await h.call("wording.save", { prompts: { [family]: ["Mi enunciado: {expr}"] } })).value
        .saved,
    ).toEqual([family]);
    expect((await h.call("exam.generate")).value.count).toBe(10);
  });

  it("fails the job with model_failed when the output has no usable template", async () => {
    const h = await appHarness({ complete: async () => "No." });
    await h.approvedExam();
    const job = await h.settle((await h.call("wording.draft")).value.jobId);
    expect(job).toMatchObject({ state: "failed", error: "model_failed" });
  });
});

/** Rewrites the active exam's exam.yaml (an exam drafted by an older version, for example). */
async function editExam(
  h: Awaited<ReturnType<typeof appHarness>>,
  change: (spec: ReturnType<typeof parseExam>) => void,
) {
  const folder = (await h.call("status")).value.exams[0].folder as string;
  const path = join(h.workspace, "evalua", "exams", folder, "exam.yaml");
  const spec = parseExam(await readFile(path, "utf8"));
  change(spec);
  await writeFile(path, stringifyExam(spec));
  return path;
}

const onlyMultipleChoice = (spec: ReturnType<typeof parseExam>) => {
  spec.itemTypes = { single_choice: 0, multiple_choice: 10, open: 0, practice: 0 };
};

describe("drafting that always works", () => {
  it("retries once with the problem when the first answer is unusable", async () => {
    let calls = 0;
    const h = await appHarness({
      complete: async (request) => {
        calls += 1;
        return calls === 1 ? "<think>hmm {expr}</think> I would write {expr}." : drafting(request);
      },
    });
    await h.approvedExam();
    const job = await h.settle((await h.call("wording.draft")).value.jobId);
    expect(job.state).toBe("done");
    expect(h.completions).toHaveLength(2);
    const retry = h.completions[1];
    expect(retry?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(retry?.messages[2]?.text).toMatch(/only the JSON object/i);
    expect(retry?.maxTokens).toBe(4000);
  });

  it("names the failure: unreadable or rejected after the retry, model_error without one", async () => {
    const unreadable = await appHarness({ complete: async () => "No." });
    await unreadable.approvedExam();
    const first = await unreadable.settle((await unreadable.call("wording.draft")).value.jobId);
    expect(first).toMatchObject({ state: "failed", error: "model_failed", detail: "unreadable" });
    expect(unreadable.completions).toHaveLength(2);

    const rejected = await appHarness({
      complete: async () => JSON.stringify({ "integer-ops": ["Calcula el resultado."] }),
    });
    await rejected.approvedExam();
    const second = await rejected.settle((await rejected.call("wording.draft")).value.jobId);
    expect(second).toMatchObject({ state: "failed", error: "model_failed", detail: "rejected" });

    const broken = await appHarness({
      complete: async () => {
        throw new Error("provider exploded at /secret/path");
      },
    });
    await broken.approvedExam();
    const third = await broken.settle((await broken.call("wording.draft")).value.jobId);
    expect(third).toMatchObject({ state: "failed", error: "model_failed", detail: "model_error" });
    expect(JSON.stringify(third)).not.toContain("secret");
    expect(broken.completions).toHaveLength(1);
  });

  it("stops without a retry when the draft is cancelled", async () => {
    const h = await appHarness({
      complete: (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener("abort", () => resolve("No."));
        }),
    });
    await h.approvedExam();
    const { jobId } = (await h.call("wording.draft")).value;
    await h.call("jobs.cancel", { jobId });
    expect((await h.settle(jobId)).state).toBe("cancelled");
    expect(h.completions).toHaveLength(1);
  });

  it("does not call the model when the exam's questions all come from the bank", async () => {
    const h = await appHarness({ complete: drafting });
    await h.approvedExam();
    await editExam(h, (spec) => {
      spec.topics = ["basic-math/natural-numbers"];
      spec.packs = ["basic-math"];
    });
    const wording = (await h.call("wording.get")).value;
    expect(wording.families).toEqual([]);
    const drafted = await h.call("wording.draft");
    expect(drafted.value).toMatchObject({ jobId: null, families: 0 });
    expect(h.completions).toHaveLength(0);
  });

  it("lists and drafts the topic's families even when the plan asks for an unsupported type", async () => {
    const h = await appHarness({ complete: drafting });
    await h.approvedExam();
    const before = (await h.call("wording.get")).value.families;
    await editExam(h, onlyMultipleChoice);
    const wording = (await h.call("wording.get")).value;
    expect(wording.families.map((family: { id: string }) => family.id)).toEqual(
      before.map((family: { id: string }) => family.id),
    );
    expect(wording.families.length).toBeGreaterThan(0);
    expect(wording.families[0].sample).toMatch(/\$/);
    // Deterministic: the sample does not change between calls.
    expect((await h.call("wording.get")).value.families[0].sample).toBe(wording.families[0].sample);
    const job = await h.settle((await h.call("wording.draft")).value.jobId);
    expect(job.state).toBe("done");
    expect((await h.call("wording.get")).value.families[0].draft).toEqual([
      "Calcula con cuidado: {expr}",
    ]);
  });

  it("saves the wording even when the questions cannot be created again", async () => {
    const h = await appHarness();
    const examId = await h.approvedExam();
    expect((await h.call("exam.generate")).value.count).toBe(10);
    const path = await editExam(h, onlyMultipleChoice);
    const family = (await h.call("wording.get")).value.families[0].id as string;
    const saved = await h.call("wording.save", { prompts: { [family]: ["Resuelve: {expr}"] } });
    expect(saved.value).toMatchObject({ saved: [family], regenerated: false, blocked: true });
    expect(saved.value.capacity?.length).toBeGreaterThan(0);
    expect(parseExam(await readFile(path, "utf8")).itemPrompts).toEqual({
      [family]: ["Resuelve: {expr}"],
    });
    // The plan itself is never changed automatically.
    expect(parseExam(await readFile(path, "utf8")).itemTypes.multiple_choice).toBe(10);
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("approved-a");
  });
});
