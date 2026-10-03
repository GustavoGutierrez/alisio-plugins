import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallCancelled, InstallFailure } from "../src/runtime/installer.js";
import { SetupJobs } from "../src/runtime/jobs.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-jobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stored = async () => JSON.parse(await readFile(join(dir, "current.json"), "utf8"));

describe("SetupJobs", () => {
  it("returns immediately after start and runs the job in the background", async () => {
    const gate = deferred();
    const jobs = new SetupJobs({ dir });
    const run = vi.fn(async () => gate.promise);
    expect(jobs.start("install", run)).toBe("started");
    expect(jobs.current()?.state).toBe("running");
    expect(run).toHaveBeenCalledOnce();
    gate.resolve();
    await jobs.whenIdle();
    expect(jobs.current()?.state).toBe("succeeded");
    expect((await stored()).state).toBe("succeeded");
  });

  it("starts nothing while a job runs and reports busy", async () => {
    const gate = deferred();
    const jobs = new SetupJobs({ dir });
    jobs.start("install", () => gate.promise);
    const second = vi.fn(async () => {});
    expect(jobs.start("repair", second)).toBe("busy");
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await jobs.whenIdle();
  });

  it("records steps and elapsed timestamps atomically on every transition", async () => {
    const gate = deferred();
    let now = Date.parse("2026-10-03T00:00:00Z");
    const jobs = new SetupJobs({ dir, now: () => new Date(now) });
    jobs.start("install", async (ctx) => {
      ctx.step(2, "installing packages");
      await gate.promise;
    });
    await jobs.flush();
    expect(jobs.current()?.step).toEqual({ n: 2, total: 6, name: "installing packages" });
    expect((await stored()).step.name).toBe("installing packages");
    now += 5000;
    gate.resolve();
    await jobs.whenIdle();
    expect(jobs.current()?.updatedAt).toBe(new Date(now).toISOString());
    expect(jobs.current()?.startedAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("records a failure with its code and a short message, no secrets", async () => {
    const jobs = new SetupJobs({ dir });
    jobs.start("install", async () => {
      throw new InstallFailure(
        "pip_failed",
        "installing packages",
        "installing packages failed: no network",
      );
    });
    await jobs.whenIdle();
    expect(jobs.current()).toMatchObject({
      state: "failed",
      failureCode: "pip_failed",
      message: "installing packages failed: no network",
    });
  });

  it("maps unexpected errors to a generic failure without echoing them", async () => {
    const jobs = new SetupJobs({ dir });
    jobs.start("install", async () => {
      throw new Error("token=abc leaked");
    });
    await jobs.whenIdle();
    expect(jobs.current()?.state).toBe("failed");
    expect(JSON.stringify(jobs.current())).not.toContain("leaked");
  });

  it("cancel aborts the job signal and ends cancelled", async () => {
    const jobs = new SetupJobs({ dir });
    let seen: AbortSignal | undefined;
    jobs.start("install", (ctx) => {
      seen = ctx.signal;
      return new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new InstallCancelled()));
      });
    });
    expect(jobs.cancel()).toBe("cancelled");
    await jobs.whenIdle();
    expect(seen?.aborted).toBe(true);
    expect(jobs.current()?.state).toBe("cancelled");
  });

  it("cancel with no running job is a no-op", () => {
    const jobs = new SetupJobs({ dir });
    expect(jobs.cancel()).toBe("none");
  });

  it("dispose cancels a running job and waits for it", async () => {
    const jobs = new SetupJobs({ dir });
    jobs.start(
      "install",
      (ctx) =>
        new Promise<void>((_r, reject) =>
          ctx.signal.addEventListener("abort", () => reject(new InstallCancelled())),
        ),
    );
    await jobs.dispose();
    expect(jobs.current()?.state).toBe("cancelled");
  });

  it("dispose does not hang on a job that ignores cancellation", async () => {
    const jobs = new SetupJobs({ dir, disposeWaitMs: 50 });
    jobs.start("install", () => new Promise<void>(() => {}));
    const started = Date.now();
    await jobs.dispose();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports a stale running record from a dead host as interrupted", async () => {
    await writeFile(
      join(dir, "current.json"),
      JSON.stringify({
        version: 1,
        kind: "install",
        state: "running",
        startedAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T00:00:01.000Z",
        step: { n: 2, total: 6, name: "installing packages" },
      }),
    );
    const jobs = new SetupJobs({ dir });
    await jobs.load();
    expect(jobs.current()?.state).toBe("interrupted");
    expect((await stored()).state).toBe("interrupted");
    expect(jobs.start("repair", async () => {})).toBe("started");
    await jobs.whenIdle();
  });

  it("ignores a malformed record", async () => {
    await writeFile(join(dir, "current.json"), "{broken");
    const jobs = new SetupJobs({ dir });
    await jobs.load();
    expect(jobs.current()).toBeUndefined();
  });

  it("keeps a finished record loadable across restarts", async () => {
    const first = new SetupJobs({ dir });
    first.start("install", async () => {});
    await first.whenIdle();
    const second = new SetupJobs({ dir });
    await second.load();
    expect(second.current()?.state).toBe("succeeded");
  });

  it("notifies on every transition", async () => {
    const onChange = vi.fn();
    const jobs = new SetupJobs({ dir, onChange });
    jobs.start("install", async (ctx) => {
      ctx.step(1, "creating environment");
    });
    await jobs.whenIdle();
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
