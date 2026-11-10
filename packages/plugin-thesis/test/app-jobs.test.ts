import { afterEach, describe, expect, it } from "vitest";
import { JobRegistry, StudioError } from "../src/app/jobs.js";
import { json, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers } from "./helpers/harness.js";
import { studio } from "./helpers/studio.js";

afterEach(cleanup);

async function designPhase() {
  const s = await studio({ answers: intakeAnswers });
  await s.h.run("init", "--lang es-CO");
  return s;
}

describe("JobRegistry", () => {
  it("dedupes progress, keeps 20 lines and 20 records, and maps failures to codes", async () => {
    const jobs = new JobRegistry();
    let finish: (() => void) | undefined;
    const view = jobs.start(
      { kind: "x", label: "x" },
      () => undefined,
      async (hooks) => {
        for (let i = 0; i < 30; i++) {
          hooks.progress(`line ${i}`);
          hooks.progress(`line ${i}`);
        }
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "ok" };
      },
    );
    for (let i = 0; !finish && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
    const running = jobs.get(view.id);
    expect(running?.progress).toHaveLength(20);
    expect(running?.progress[0]).toBe("line 10");
    expect(jobs.busy()).toBe(true);
    finish?.();
    for (let i = 0; jobs.busy() && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.get(view.id)).toMatchObject({ state: "done", result: "ok" });

    const failed = jobs.start(
      { kind: "y", label: "y" },
      () => undefined,
      async () => {
        throw new StudioError("blocked", { reason: "Gate A is pending." });
      },
    );
    for (let i = 0; jobs.busy() && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.get(failed.id)).toMatchObject({
      state: "failed",
      error: "blocked",
      reason: "Gate A is pending.",
    });
    const crashed = jobs.start(
      { kind: "z", label: "z" },
      () => undefined,
      async () => {
        throw new Error(`SECRET-DETAIL ${"x".repeat(10)}`);
      },
    );
    for (let i = 0; jobs.busy() && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.get(crashed.id)).toMatchObject({ state: "failed", error: "operation_failed" });
    expect(JSON.stringify(jobs.get(crashed.id))).not.toContain("SECRET-DETAIL");

    const ids: string[] = [];
    for (let i = 0; i < 25; i++)
      ids.push(
        jobs.start(
          { kind: "n", label: "n" },
          () => undefined,
          async () => ({}),
        ).id,
      );
    for (let i = 0; jobs.busy() && i < 100; i++) await new Promise((r) => setTimeout(r, 2));
    jobs.start(
      { kind: "n", label: "n" },
      () => undefined,
      async () => ({}),
    );
    expect(jobs.get(view.id)).toBeUndefined();
    expect(jobs.get(ids.at(-1) as string)).toBeDefined();
  });
});

describe("long jobs (THA-AC-07)", () => {
  it("returns a job id at once, reports child progress and keeps busy() true while it runs", async () => {
    const s = await designPhase();
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const release = s.holdChildren();
    const started = Date.now();
    const result = await s.call("design.run", {});
    expect(Date.now() - started).toBeLessThan(2000);
    const { jobId } = result.value as { jobId: string };
    await s.untilChildRuns();
    expect(s.app?.busy?.()).toBe(true);
    const running = (await s.call("jobs.get", { jobId })).value as Record<string, unknown>;
    expect(running).toMatchObject({
      state: "running",
      kind: "design.run",
      label: "the research plan draft",
    });
    expect(running.progress).toEqual([expect.stringMatching(/^thesis-methodologist: running/)]);
    const status = (await s.call("status", {})).value as { job: { id: string } | null };
    expect(status.job?.id).toBe(jobId);
    release();
    const done = await s.waitJob(jobId);
    expect(done.state).toBe("done");
    expect(s.app?.busy?.()).toBe(false);
    expect(((await s.call("status", {})).value as { job: unknown }).job).toBeNull();
  });
});

describe("cancel (THA-AC-08)", () => {
  it("aborts the signal, cancels every recorded child and frees the lock", async () => {
    const s = await designPhase();
    s.h.script("thesis-methodologist", json(protocolDraft()));
    s.holdChildren();
    const { jobId } = (await s.call("design.run", {})).value as { jobId: string };
    await s.untilChildRuns();
    const signal = s.runSignals.at(-1) as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(await s.call("jobs.cancel", { jobId })).toEqual({ value: { cancelled: true } });
    expect(signal.aborted).toBe(true);
    expect(s.cancelled).toEqual(["child-1"]);
    const job = (await s.call("jobs.get", { jobId })).value as Record<string, unknown>;
    expect(job).toMatchObject({ state: "cancelled", error: "cancelled" });
    expect(s.app?.busy?.()).toBe(false);
    // The lock is free: a command runs again.
    expect(await s.h.run("check")).not.toMatch(/^Blocked/);
    expect(await s.call("jobs.cancel", { jobId })).toEqual({ value: { cancelled: false } });
    expect(await s.call("jobs.cancel", { jobId: "job-missing" })).toEqual({ error: "not_found" });
  });
});

describe("dispose (THA-AC-18)", () => {
  it("is idempotent, cancels the running job and frees the lock", async () => {
    const s = await designPhase();
    s.h.script("thesis-methodologist", json(protocolDraft()));
    s.holdChildren();
    const { jobId } = (await s.call("design.run", {})).value as { jobId: string };
    await s.untilChildRuns();
    expect(s.app?.busy?.()).toBe(true);
    s.app?.dispose?.();
    s.app?.dispose?.();
    expect(s.app?.busy?.()).toBe(false);
    expect(s.cancelled).toEqual(["child-1"]);
    expect(((await s.call("jobs.get", { jobId })).value as { state: string }).state).toBe(
      "cancelled",
    );
    expect(await s.h.run("check")).not.toMatch(/^Blocked/);
    // A disposed activation starts nothing new.
    expect(await s.call("design.run", {})).toEqual({ error: "operation_failed" });
  });
});
