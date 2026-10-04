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

  describe("cross-process ownership", () => {
    const base = {
      version: 1,
      kind: "install",
      state: "running",
      startedAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:01.000Z",
      step: { n: 2, total: 6, name: "installing packages" },
    };
    const write = (extra: Record<string, unknown>) =>
      writeFile(join(dir, "current.json"), JSON.stringify({ ...base, ...extra }));
    const raw = () => readFile(join(dir, "current.json"), "utf8");
    const probe = (alive: boolean, token?: string) => ({
      alive: vi.fn(() => alive),
      startToken: vi.fn(() => token),
    });

    it("stores the owner pid and start token in the running record", async () => {
      const gate = deferred();
      const jobs = new SetupJobs({ dir, pid: 4242, probe: probe(true, "tok") });
      jobs.start("install", () => gate.promise);
      await jobs.flush();
      const record = await stored();
      expect(record.pid).toBe(4242);
      expect(record.ownerStart).toBe("tok");
      gate.resolve();
      await jobs.whenIdle();
    });

    it("leaves a running record owned by a live other process untouched", async () => {
      await write({ pid: 4242 });
      const before = await raw();
      const jobs = new SetupJobs({ dir, pid: 1, probe: probe(true) });
      await jobs.load();
      await jobs.flush();
      expect(jobs.current()?.state).toBe("running");
      expect(jobs.ownedElsewhere()).toBe(true);
      expect(await raw()).toBe(before);
      expect(jobs.start("repair", async () => {})).toBe("busy");
      expect(jobs.cancel()).toBe("other_process");
      expect(await raw()).toBe(before);
    });

    it("marks a record whose owner is provably dead as interrupted", async () => {
      await write({ pid: 4242 });
      const jobs = new SetupJobs({ dir, pid: 1, probe: probe(false) });
      await jobs.load();
      expect(jobs.current()?.state).toBe("interrupted");
      expect(jobs.ownedElsewhere()).toBe(false);
      expect((await stored()).state).toBe("interrupted");
    });

    it("treats a reused pid (different start token) as a dead owner", async () => {
      await write({ pid: 4242, ownerStart: "old" });
      const jobs = new SetupJobs({ dir, pid: 1, probe: probe(true, "new") });
      await jobs.load();
      expect(jobs.current()?.state).toBe("interrupted");
    });

    it("keeps the record running when the start token matches or is unavailable", async () => {
      await write({ pid: 4242, ownerStart: "same" });
      const a = new SetupJobs({ dir, pid: 1, probe: probe(true, "same") });
      await a.load();
      expect(a.current()?.state).toBe("running");
      const b = new SetupJobs({ dir, pid: 1, probe: probe(true, undefined) });
      await b.load();
      expect(b.current()?.state).toBe("running");
    });

    it("keeps legacy records without a pid on the previous behavior", async () => {
      await write({});
      const p = probe(true);
      const jobs = new SetupJobs({ dir, pid: 1, probe: p });
      await jobs.load();
      expect(jobs.current()?.state).toBe("interrupted");
      expect(p.alive).not.toHaveBeenCalled();
    });

    it("default probe: ESRCH is dead, EPERM is alive", async () => {
      const kill = vi.spyOn(process, "kill");
      try {
        kill.mockImplementation(() => {
          throw Object.assign(new Error("x"), { code: "EPERM" });
        });
        await write({ pid: 999999 });
        const alive = new SetupJobs({ dir, pid: 1 });
        await alive.load();
        expect(alive.current()?.state).toBe("running");
        kill.mockImplementation(() => {
          throw Object.assign(new Error("x"), { code: "ESRCH" });
        });
        const dead = new SetupJobs({ dir, pid: 1 });
        await dead.load();
        expect(dead.current()?.state).toBe("interrupted");
      } finally {
        kill.mockRestore();
      }
    });

    it("refresh re-reads a foreign record and picks up its completion", async () => {
      await write({ pid: 4242 });
      const jobs = new SetupJobs({ dir, pid: 1, probe: probe(true) });
      await jobs.load();
      await write({ pid: 4242, state: "succeeded" });
      await jobs.refresh();
      expect(jobs.current()?.state).toBe("succeeded");
      expect(jobs.ownedElsewhere()).toBe(false);
    });

    it("records the activation outcome on a finished job", async () => {
      const jobs = new SetupJobs({ dir, now: () => new Date("2026-10-03T01:00:00Z") });
      jobs.start("install", async () => {});
      await jobs.whenIdle();
      jobs.setActivation({ status: "declined" });
      await jobs.flush();
      expect((await stored()).activation).toEqual({
        status: "declined",
        at: "2026-10-03T01:00:00.000Z",
      });
    });
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
