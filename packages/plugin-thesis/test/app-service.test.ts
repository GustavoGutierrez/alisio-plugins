import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RendererRegistry } from "../src/render/registry.js";
import { readState, writeState } from "../src/storage.js";
import { json, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers, round1 } from "./helpers/harness.js";
import { drafted, researched } from "./helpers/phase5.js";
import { fakePdf, studio, studioHost } from "./helpers/studio.js";

afterEach(cleanup);

const statePath = (workspace: string) => join(workspace, ".alisio", "thesis", "state.json");

describe("produce then decide (THA-AC-03)", () => {
  it("runs design.run without asking in the chat even when the UI is interactive", async () => {
    const s = await studio({ answers: intakeAnswers });
    await s.h.run("init", "--lang es-CO");
    const askedBefore = s.h.asked.length;
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const { jobId } = (await s.call("design.run", {})).value as { jobId: string };
    const job = await s.waitJob(jobId);
    expect(job.state).toBe("done");
    expect(String(job.result)).toContain("/thesis:approve A");
    expect(s.h.asked.length).toBe(askedBefore);
    const state = await s.h.state();
    expect(state.humanGates.A.status).toBe("pending");
    expect(state.humanGates.B.status).toBe("pending");
    const status = (await s.call("status", {})).value as Record<string, unknown>;
    expect(status.nextStep).toEqual({
      action: "approve",
      target: "A",
      phase: "design",
      reasonKey: "approve_gate_a",
    });
    // The children ran with the job signal (cancellable).
    expect(s.runSignals.at(-1)).toBeInstanceOf(AbortSignal);
  });
});

describe("revision guard (THA-AC-04)", () => {
  it("refuses a decision on a state the user has not seen", async () => {
    const s = await studio({ answers: intakeAnswers });
    await s.h.run("init", "--lang es-CO");
    s.h.setInteractive(false);
    s.h.script("thesis-methodologist", json(protocolDraft()));
    await s.h.run("design");
    const seen = await s.revision();
    // The chat changes the state after the frame read it.
    await s.h.run("approve", "A");
    const before = await readFile(statePath(s.h.workspace), "utf8");
    expect(await s.call("approve", { target: "B", revision: seen })).toEqual({
      error: "conflict",
    });
    expect(await readFile(statePath(s.h.workspace), "utf8")).toBe(before);
    const ok = await s.call("approve", { target: "B", revision: await s.revision() });
    expect(ok.error).toBeUndefined();
    expect((await s.h.state()).humanGates.B.status).toBe("approved");
  });

  it("repeats the first result for a repeated idempotency key", async () => {
    const s = await studio({ answers: intakeAnswers });
    await s.h.run("init", "--lang es-CO");
    s.h.setInteractive(false);
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const first = await s.call("design.run", {}, { idempotencyKey: "k-1" });
    const second = await s.call("design.run", {}, { idempotencyKey: "k-1" });
    expect(second).toEqual(first);
    await s.waitJob((first.value as { jobId: string }).jobId);
  });
});

describe("chapter approval from the app (THA-AC-05)", () => {
  it("approves the section and leaves the partial build to a separate process action", async () => {
    const renderer = fakePdf();
    const host = studioHost({
      coordinator: { registry: new RendererRegistry().register(renderer) },
    });
    const h = await researched({
      extend: host.extend,
      coordinator: { registry: new RendererRegistry().register(renderer) },
    });
    const s = host.bind(h);
    await drafted(h);
    expect((await h.state()).sections["SEC-07"].status).toBe("draft_review");
    const approved = await s.call("approve", { target: "SEC-07", revision: await s.revision() });
    expect(approved.error).toBeUndefined();
    expect(approved.value).toMatchObject({ buildAfter: true });
    expect(String((approved.value as { text: string }).text)).not.toContain("Build skipped");
    expect((await h.state()).sections["SEC-07"].status).toBe("approved");
    expect(renderer.calls).toEqual([]);
    // The frame then starts the build (effect "process").
    expect(s.app?.actions?.["build.run"]?.effect).toBe("process");
    const { jobId } = (await s.call("build.run", { scope: "approved" })).value as {
      jobId: string;
    };
    const job = await s.waitJob(jobId);
    expect(job).toMatchObject({ state: "done", value: { ok: true, pages: 3 } });
    expect(renderer.calls).toEqual([{ scope: "approved" }]);
    expect(JSON.stringify(job)).not.toContain(h.workspace);
  });
});

describe("interview from the app (THA-AC-13)", () => {
  it("parks rounds, reports invalid answers per question and writes nothing, then advances", async () => {
    const s = await studio();
    const init = await s.call("project.init", { lang: "es-CO" });
    expect(init.error).toBeUndefined();
    // Never asked in the chat: the round is parked for the wizard.
    expect(s.h.asked).toEqual([]);
    const interview = (await s.call("interview.get", {})).value as {
      pending: { round: number; questions: { id: string }[] };
    };
    expect(interview.pending.round).toBe(1);
    const ids = interview.pending.questions.map((q) => q.id);
    expect(ids).toContain("workType");

    const before = await readFile(statePath(s.h.workspace), "utf8");
    const bad = await s.call("interview.answer", {
      answers: { ...round1, workType: "not-a-work-type" },
    });
    expect(bad).toEqual({ error: "invalid_input", fields: ["workType"] });
    expect(await readFile(statePath(s.h.workspace), "utf8")).toBe(before);

    const good = await s.call("interview.answer", { answers: round1 });
    expect(good.error).toBeUndefined();
    expect(good.value).toMatchObject({ pending: { round: 2 }, completedRounds: [1] });
    expect(await s.call("interview.answer", { answers: { nope: "x" } })).toMatchObject({
      error: "invalid_input",
    });
  });
});

describe("pdf.get (THA-AC-16)", () => {
  it("returns the last PDF as base64 and refuses one above the cap", async () => {
    const renderer = fakePdf();
    const s = await studio({
      answers: intakeAnswers,
      coordinator: { registry: new RendererRegistry().register(renderer) },
    });
    expect(await s.call("pdf.get", { which: "last" })).toEqual({ error: "not_initialized" });
    await s.h.run("init", "--lang es-CO");
    expect(await s.call("pdf.get", { which: "last" })).toEqual({ error: "not_found" });
    const { jobId } = (await s.call("build.run", { scope: "full" })).value as { jobId: string };
    expect((await s.waitJob(jobId)).state).toBe("done");
    const pdf = (await s.call("pdf.get", { which: "last" })).value as {
      base64: string;
      bytes: number;
      path: string;
    };
    expect(Buffer.from(pdf.base64, "base64").toString()).toBe("%PDF-1.7 fake");
    expect(pdf.path).toBe("thesis/build/thesis.pdf");

    const state = (await readState(s.h.workspace)) as NonNullable<
      Awaited<ReturnType<typeof readState>>
    >;
    const big = join(s.h.workspace, "thesis", "build", "big.pdf");
    const handle = await open(big, "w");
    await handle.truncate(61 * 1024 * 1024);
    await handle.close();
    await writeState(s.h.workspace, {
      ...state,
      lastBuild: {
        ...(state.lastBuild as NonNullable<typeof state.lastBuild>),
        pdf: "thesis/build/big.pdf",
      },
    });
    expect(await s.call("pdf.get", { which: "last" })).toEqual({
      error: "too_large",
      path: "thesis/build/big.pdf",
    });
  });
});
