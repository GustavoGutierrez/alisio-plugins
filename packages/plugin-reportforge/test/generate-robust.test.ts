import { afterEach, describe, expect, it } from "vitest";
import {
  buildPrompt,
  buildRepairPrompt,
  extractAnswer,
  GenerationError,
  generateWithAlisio,
  MAX_OUTPUT_CHARS,
  MIN_VALID_BLOCKS,
  outputBudget,
  parseAnswer,
  salvageBlocks,
  toGenerated,
} from "../src/generate.js";
import { initialReport } from "../src/types.js";
import { type FakeRun, fakeHost, VALID_ANSWER } from "./helpers/fake-api.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const JSON_ANSWER = JSON.stringify(VALID_ANSWER);
const signal = () => new AbortController().signal;

describe("extractAnswer", () => {
  it("drops think blocks, even ones full of braces", () => {
    const text = `<think>Maybe {"blocks": 1} or {draft}? Let me plan { carefully.</think>\n${JSON_ANSWER}`;
    expect(extractAnswer(text).object?.title).toBe("Quarterly results");
    const thinking = `<thinking>{oops</thinking>${JSON_ANSWER}`;
    expect(extractAnswer(thinking).object?.title).toBe("Quarterly results");
  });

  it("ignores prose with braces before and after the JSON", () => {
    const text = `Sure! I used {sources} and the {goal}.\n${JSON_ANSWER}\nHope this helps {really}.`;
    expect(extractAnswer(text).object?.title).toBe("Quarterly results");
  });

  it("prefers a json fence anywhere in the answer", () => {
    const text = `Here is a sketch {"title":"draft"}.\n\n\`\`\`json\n${JSON_ANSWER}\n\`\`\`\nNotes after the fence {x}.`;
    expect(extractAnswer(text).object?.title).toBe("Quarterly results");
  });

  it("picks the object that has a blocks array among several", () => {
    const text = `{"note":"plan first"}\n${JSON_ANSWER}`;
    expect(extractAnswer(text).object?.title).toBe("Quarterly results");
    expect(extractAnswer('{"a":1} {"b":2}').object).toEqual({ a: 1 });
  });

  it("flags a truncated object instead of calling it unreadable", () => {
    const cut = JSON_ANSWER.slice(0, Math.floor(JSON_ANSWER.length * 0.7));
    expect(extractAnswer(cut)).toEqual({ truncated: true });
    expect(extractAnswer(`\`\`\`json\n${cut}`)).toEqual({ truncated: true });
    expect(extractAnswer("<think>still reasoning about {the data")).toEqual({ truncated: true });
  });

  it("reports prose without any object as neither found nor truncated", () => {
    expect(extractAnswer("I need more information. Which quarter?")).toEqual({ truncated: false });
  });

  it("keeps the size guard and a bounded scan on huge brace-heavy input", () => {
    expect(() => extractAnswer(`{"a":"${"x".repeat(MAX_OUTPUT_CHARS)}"}`)).toThrow(
      "generation_too_large",
    );
    const started = Date.now();
    const result = extractAnswer("{".repeat(MAX_OUTPUT_CHARS - 10));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.object).toBeUndefined();
  });
});

describe("parseAnswer", () => {
  it("throws a classified code", () => {
    expect(() => parseAnswer("No JSON here.")).toThrow("generation_unreadable");
    expect(() => parseAnswer('{"title": "x", "blocks": [')).toThrow("generation_truncated");
    try {
      parseAnswer("plain");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).reason).toBe("unreadable");
    }
  });
});

describe("tolerant blocks", () => {
  it("drops individual invalid blocks and counts them", () => {
    const { blocks, dropped } = salvageBlocks([
      ...VALID_ANSWER.blocks,
      { type: "script", text: "x" },
      { type: "bars", title: "t", labels: ["a"], values: ["NaN"] },
      { type: "paragraph", text: "x".repeat(30_000) },
      "not a block",
    ]);
    expect(blocks).toHaveLength(6);
    expect(dropped).toBe(4);
  });

  it("caps the number of blocks, counting the overflow as dropped", () => {
    const raw = Array.from({ length: 90 }, () => ({ type: "paragraph", text: "x" }));
    const { blocks, dropped } = salvageBlocks(raw);
    expect(blocks).toHaveLength(80);
    expect(dropped).toBe(10);
  });

  it("keeps a report with enough valid blocks and records what was dropped", () => {
    const parsed = { ...VALID_ANSWER, blocks: [...VALID_ANSWER.blocks, { type: "nope" }] };
    const out = toGenerated(parsed, initialReport({}));
    expect(out.blocks).toHaveLength(6);
    expect(out.dropped).toBe(1);
  });

  it("rejects a report with too few valid blocks as an invalid structure", () => {
    expect(MIN_VALID_BLOCKS).toBe(3);
    const twoGood = [VALID_ANSWER.blocks[0], VALID_ANSWER.blocks[1], { type: "x" }, { type: "y" }];
    expect(() => toGenerated({ blocks: twoGood }, initialReport({}))).toThrow(
      "generation_invalid_structure",
    );
    expect(() => toGenerated({ title: "no blocks" }, initialReport({}))).toThrow(
      "generation_invalid_structure",
    );
    expect(() => toGenerated({ blocks: [] }, initialReport({}))).toThrow(
      "generation_invalid_structure",
    );
  });

  it("accepts a short but fully valid report", () => {
    const out = toGenerated({ blocks: VALID_ANSWER.blocks.slice(0, 2) }, initialReport({}));
    expect(out.blocks).toHaveLength(2);
    expect(out.dropped).toBe(0);
  });
});

describe("prompts and budgets", () => {
  it("asks for one compact JSON object, never questions or Markdown", () => {
    const prompt = buildPrompt(initialReport({ language: "en" }), "Go");
    expect(prompt).toContain("at most 12 components");
    expect(prompt).toMatch(/never ask questions/i);
    expect(prompt).toContain('"blocks"');
  });

  it("builds a stricter repair prompt per reason", () => {
    const truncated = buildRepairPrompt("truncated");
    expect(truncated).toContain("cut off");
    expect(truncated).toContain("at most 8 components");
    expect(buildRepairPrompt("unreadable")).toContain("only one JSON object");
    expect(buildRepairPrompt("invalid_structure")).toContain('"blocks"');
  });

  it("derives the output budget from the model catalog", () => {
    expect(outputBudget(undefined)).toBe(16_384);
    expect(outputBudget({ maxOutputTokens: 8_192 })).toBe(8_192);
    expect(outputBudget({ maxOutputTokens: 128_000 })).toBe(32_768);
    expect(outputBudget({ maxOutputTokens: 64_000, contextWindow: 32_000 })).toBe(16_000);
  });
});

async function hostWith(
  runs: Array<FakeRun | Error | ((signal?: AbortSignal) => Promise<FakeRun>)>,
  extra: Parameters<typeof fakeHost>[0] = {},
) {
  let index = 0;
  const host = await fakeHost({
    ...extra,
    run: async (_prompt, s) => {
      const next = runs[Math.min(index++, runs.length - 1)];
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(s);
      return next as FakeRun;
    },
  });
  cleanup = host.cleanup;
  return host;
}

describe("generateWithAlisio (fake model, robust path)", () => {
  it("uses a catalog-sized output budget and a longer timeout", async () => {
    const host = await hostWith([{ text: JSON_ANSWER }], {
      models: [{ reference: "acme/big", providerName: "Acme", model: { maxOutputTokens: 64_000 } }],
    });
    const r = initialReport({ model: "acme/big" });
    await generateWithAlisio(host.api, "s1", r, "", signal());
    expect(host.created[0]).toMatchObject({ maxOutputTokens: 32_768 });
    expect(host.created[0]?.maxTokens).toBeUndefined();
    expect(Number(host.created[0]?.timeoutMs)).toBeGreaterThanOrEqual(300_000);
  });

  it("repairs a bad answer once in the same child session", async () => {
    const host = await hostWith([{ text: "Which quarter do you mean?" }, { text: JSON_ANSWER }]);
    const out = await generateWithAlisio(host.api, "s1", initialReport({}), "", signal());
    expect(out.title).toBe("Quarterly results");
    expect(host.created).toHaveLength(1);
    expect(host.runs).toEqual(["child-1", "child-1"]);
    expect(host.prompts[1]).toContain("only one JSON object");
  });

  it("asks for a compact report after a truncated answer", async () => {
    const cut = JSON_ANSWER.slice(0, 200);
    const host = await hostWith([{ text: cut }, { text: JSON_ANSWER }]);
    await generateWithAlisio(host.api, "s1", initialReport({}), "", signal());
    expect(host.prompts[1]).toContain("at most 8 components");
  });

  it("classifies a cut-off answer near the output limit as truncated", async () => {
    const host = await hostWith([
      { text: "Sorry", output: 16_300 },
      { text: "Sorry", output: 32_600 },
    ]);
    await expect(
      generateWithAlisio(host.api, "s1", initialReport({}), "", signal()),
    ).rejects.toThrow("generation_truncated");
  });

  it("fails with the reason of the second attempt when both are bad", async () => {
    const host = await hostWith([{ text: "nope" }, { text: '{"title":"x"}' }]);
    const error = await generateWithAlisio(host.api, "s1", initialReport({}), "", signal()).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.message).toBe("generation_invalid_structure");
    expect(host.runs).toHaveLength(2);
  });

  it("retries an incomplete run in a fresh child session", async () => {
    const host = await hostWith([{ status: "failed", text: "" }, { text: JSON_ANSWER }]);
    const out = await generateWithAlisio(host.api, "s1", initialReport({}), "", signal());
    expect(out.title).toBe("Quarterly results");
    expect(host.created).toHaveLength(2);
    expect(host.runs).toEqual(["child-1", "child-2"]);
    expect(host.prompts[1]).toContain("did not finish");
  });

  it("classifies a host truncation failure", async () => {
    const host = await hostWith([
      { status: "failed", text: "", error: "The response was cut off by the output-token limit" },
    ]);
    await expect(
      generateWithAlisio(host.api, "s1", initialReport({}), "", signal()),
    ).rejects.toThrow("generation_truncated");
    expect(host.created).toHaveLength(2);
  });

  it("does not accept a turn-limited partial that is not a valid report", async () => {
    const host = await hostWith([{ status: "failed", turnsExceeded: true, text: "{}" }]);
    await expect(
      generateWithAlisio(host.api, "s1", initialReport({}), "", signal()),
    ).rejects.toThrow(/generation_(incomplete|invalid_structure)/);
  });

  it("never retries a model error", async () => {
    const thrown = await hostWith([new Error("provider exploded: secret details")]);
    await expect(
      generateWithAlisio(thrown.api, "s1", initialReport({}), "", signal()),
    ).rejects.toThrow("generation_model_error");
    expect(thrown.runs).toHaveLength(1);
    await thrown.cleanup();
    const failed = await hostWith([{ status: "failed", text: "", error: "401 unauthorized" }]);
    await expect(
      generateWithAlisio(failed.api, "s1", initialReport({}), "", signal()),
    ).rejects.toThrow("generation_model_error");
    expect(failed.runs).toHaveLength(1);
  });

  it("does not retry after an abort", async () => {
    const controller = new AbortController();
    const host = await hostWith([
      async () => {
        controller.abort();
        return { status: "cancelled", text: "" };
      },
    ]);
    await expect(
      generateWithAlisio(host.api, "s1", initialReport({}), "", controller.signal),
    ).rejects.toThrow();
    expect(host.runs).toHaveLength(1);
    expect(host.cancelled).toEqual(["child-1"]);
  });

  it("falls back to the default model when the stored one no longer exists", async () => {
    const host = await hostWith([{ text: JSON_ANSWER }]);
    const out = await generateWithAlisio(
      host.api,
      "s1",
      initialReport({ model: "gone/model" }),
      "",
      signal(),
    );
    expect(out.modelFallback).toBe(true);
    expect(host.created[0]?.model).toBeUndefined();
  });
});
