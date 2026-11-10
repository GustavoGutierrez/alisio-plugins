import { afterEach, describe, expect, it } from "vitest";
import { readPrefs } from "../src/app/prefs.js";
import {
  buildWordingPrompt,
  MAX_TEMPLATE_CHARS,
  MAX_TEMPLATES,
  parseWordingOutput,
  validateTemplates,
} from "../src/app/wording.js";
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
    expect(prompt.maxTokens).toBe(2000);
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
