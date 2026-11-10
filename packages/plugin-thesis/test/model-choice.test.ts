import type { PluginAPI } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildModel } from "../src/model-choice.js";
import { readState, validateState, writeState } from "../src/storage.js";
import { json, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers } from "./helpers/harness.js";
import { studio } from "./helpers/studio.js";

afterEach(cleanup);

async function designReady() {
  const s = await studio({
    answers: intakeAnswers,
    models: [
      { reference: "openai/gpt-test", provider: "openai", name: "GPT Test" },
      { reference: "anthropic/writer-1", provider: "anthropic", name: "Writer 1" },
    ],
  });
  await s.h.run("init", "--lang es-CO");
  s.h.setInteractive(false);
  return s;
}

const revisionOf = async (s: Awaited<ReturnType<typeof studio>>) =>
  ((await s.call("status", {})).value as { revision: string }).revision;

describe("state.settings.model", () => {
  it("validates the setting and keeps it across reads", async () => {
    const s = await designReady();
    const state = await readState(s.h.workspace);
    expect(() => validateState({ ...state, settings: { model: 5 } })).toThrow(/settings/);
    expect(() => validateState({ ...state, settings: { model: "x".repeat(201) } })).toThrow(
      /settings/,
    );
    expect(validateState({ ...state, settings: { model: null } }).settings).toEqual({
      model: null,
    });
    await writeState(s.h.workspace, {
      ...(state as never),
      settings: { model: "openai/gpt-test" },
    });
    expect((await readState(s.h.workspace))?.settings?.model).toBe("openai/gpt-test");
  });
});

describe("resolveChildModel", () => {
  it("returns nothing without a choice, the resolved reference, or a fallback notice", async () => {
    const s = await designReady();
    const fake = (resolve: (ref: string) => Promise<{ reference: string }>, active = "a/active") =>
      ({
        models: { resolve, list: async () => [] },
        sessions: { model: () => active },
      }) as unknown as PluginAPI;
    expect(
      await resolveChildModel(
        fake(async (r) => ({ reference: r })),
        s.h.workspace,
        "p",
      ),
    ).toEqual({});
    const state = (await readState(s.h.workspace)) as NonNullable<
      Awaited<ReturnType<typeof readState>>
    >;
    await writeState(s.h.workspace, { ...state, settings: { model: "x/chosen" } });
    expect(
      await resolveChildModel(
        fake(async () => ({ reference: "x/chosen" })),
        s.h.workspace,
        "p",
      ),
    ).toEqual({ model: "x/chosen" });
    expect(
      await resolveChildModel(
        fake(async () => {
          throw new Error("gone");
        }),
        s.h.workspace,
        "p",
      ),
    ).toEqual({ notice: "the chosen model is not available; used a/active" });
    // A host without api.models never fails a child.
    expect(
      await resolveChildModel(
        { sessions: { model: () => "" } } as unknown as PluginAPI,
        s.h.workspace,
        "p",
      ),
    ).toEqual({ notice: "the chosen model is not available; used Alisio's active model" });
  });
});

describe("model choice through the app and the chat (THA-AC-09, THA-AC-11)", () => {
  it("sets ChildSessionSpec.model when the choice resolves, for app jobs and chat commands alike", async () => {
    const s = await designReady();
    expect(
      await s.call("settings.setModel", { model: "nope/missing", revision: await revisionOf(s) }),
    ).toEqual({ error: "unknown_model" });
    const set = await s.call("settings.setModel", {
      model: "anthropic/writer-1",
      revision: await revisionOf(s),
    });
    expect(set.error).toBeUndefined();
    const listed = (await s.call("models.list", {})).value as Record<string, unknown>;
    expect(listed).toMatchObject({
      active: "openai/gpt-test",
      chosen: "anthropic/writer-1",
      chosenAvailable: true,
    });
    expect(listed.models).toEqual([
      { reference: "openai/gpt-test", name: "GPT Test", provider: "openai" },
      { reference: "anthropic/writer-1", name: "Writer 1", provider: "anthropic" },
    ]);

    // App job.
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const job = (await s.call("design.run", {})).value as { jobId: string };
    const done = await s.waitJob(job.jobId);
    expect(done.state).toBe("done");
    expect(s.h.prompts.at(-1)?.spec.model).toBe("anthropic/writer-1");
    expect(done.notice).toBeUndefined();

    // Chat command (parity): its children use the chosen model too.
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const text = await s.h.run("revise", "A -- Más foco");
    expect(text).not.toContain("not available");
    expect(s.h.prompts.at(-1)?.spec.model).toBe("anthropic/writer-1");
  });

  it("omits the model with a fallback notice when the choice no longer resolves, and keeps it", async () => {
    const s = await designReady();
    await s.call("settings.setModel", {
      model: "anthropic/writer-1",
      revision: await revisionOf(s),
    });
    s.setModels([{ reference: "openai/gpt-test", provider: "openai" }]);
    const listed = (await s.call("models.list", {})).value as Record<string, unknown>;
    expect(listed.chosenAvailable).toBe(false);

    s.h.script("thesis-methodologist", json(protocolDraft()));
    const job = (await s.call("design.run", {})).value as { jobId: string };
    const done = await s.waitJob(job.jobId);
    expect(done.state).toBe("done");
    expect(s.h.prompts.at(-1)?.spec).not.toHaveProperty("model");
    expect(done.notice).toBe("the chosen model is not available; used openai/gpt-test");

    s.h.script("thesis-methodologist", json(protocolDraft()));
    const text = await s.h.run("revise", "A -- Más foco");
    expect(text).toContain("Note: the chosen model is not available; used openai/gpt-test.");
    expect((await readState(s.h.workspace))?.settings?.model).toBe("anthropic/writer-1");
  });
});

describe("no model at all (THA-AC-10)", () => {
  it("refuses child-spawning actions with no_model while builds and file edits still work", async () => {
    const s = await studio({ answers: intakeAnswers, models: [], active: "" });
    await s.h.run("init", "--lang es-CO");
    s.h.setInteractive(false);
    for (const [action, input] of [
      ["design.run", {}],
      ["outline.run", {}],
      ["research.run", { section: "next" }],
      ["draft.run", { section: "next" }],
      ["review.run", { target: "all" }],
      ["next.run", {}],
      ["norms.import", { guide: "Guía de la facultad" }],
    ] as const)
      expect(await s.call(action, input), action).toEqual({ error: "no_model" });
    const listed = (await s.call("models.list", {})).value as Record<string, unknown>;
    expect(listed).toMatchObject({ models: [], active: null });

    const build = (await s.call("build.run", { scope: "full" })).value as { jobId: string };
    expect(build.jobId).toEqual(expect.any(String));
    await s.waitJob(build.jobId);
    const file = (await s.call("files.read", { path: "thesis.yaml" })).value as {
      text: string;
      revision: string;
    };
    const written = await s.call("files.write", {
      path: "thesis.yaml",
      content: file.text,
      revision: file.revision,
    });
    expect(written.error).toBeUndefined();
  });
});
