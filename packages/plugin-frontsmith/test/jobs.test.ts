import { describe, expect, it } from "vitest";
import { FeatureLockedError } from "../src/application/ports/feature-store.js";
import { FOREGROUND_COMMAND_LIMIT_MS, JobManager } from "../src/application/workflow/jobs.js";
import { createFeatureState } from "../src/domain/state/feature-state.js";
import { FsFeatureStore } from "../src/infrastructure/fs/feature-store.js";
import { tempWorkspace } from "./helpers/workspace.js";

const NOW = "2026-10-06T12:00:00.000Z";
const setup = async () => {
  const ws = await tempWorkspace();
  const store = new FsFeatureStore();
  await store.create(
    ws.root,
    createFeatureState({ feature: "projects", intent: "x", level: "L2", mode: "build", now: NOW }),
  );
  let n = 0;
  const jobs = new JobManager({
    store,
    clock: { now: () => new Date(NOW) },
    newId: () => `job-${++n}`,
    pid: process.pid,
  });
  return { ws, store, jobs };
};
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("JobManager", () => {
  it("allows foreground runs up to the limit measured in Phase 0 (S-R4)", () => {
    expect(FOREGROUND_COMMAND_LIMIT_MS).toBe(600_000);
  });

  it("starts a job and returns at once; the job is recorded and the lock is held while it runs", async () => {
    const { ws, store, jobs } = await setup();
    try {
      const gate = deferred<string>();
      const started = await jobs.start({
        root: ws.root,
        feature: "projects",
        unit: "build",
        run: () => gate.promise,
      });
      expect(started).toEqual({ id: "job-1" });
      expect(jobs.isRunning("projects")).toBe(true);
      expect((await store.read(ws.root, "projects"))!.state.job).toMatchObject({
        id: "job-1",
        unit: "build",
        ownerPid: process.pid,
      });
      expect(await store.listJobs(ws.root, "projects")).toEqual([
        expect.objectContaining({ id: "job-1", status: "running" }),
      ]);
      await expect(
        jobs.start({ root: ws.root, feature: "projects", unit: "validate", run: async () => "x" }),
      ).rejects.toBeInstanceOf(FeatureLockedError);
      gate.resolve("built 3 tasks");
      await jobs.wait("projects");
      expect(jobs.isRunning("projects")).toBe(false);
      expect((await store.read(ws.root, "projects"))!.state.job).toBeUndefined();
      expect(await store.listJobs(ws.root, "projects")).toEqual([
        expect.objectContaining({ status: "completed", summary: "built 3 tasks" }),
      ]);
      await (await store.lock(ws.root, "projects")).release();
    } finally {
      await ws.cleanup();
    }
  });

  it("records a failing job as failed and releases the lock", async () => {
    const { ws, store, jobs } = await setup();
    try {
      await jobs.start({
        root: ws.root,
        feature: "projects",
        unit: "build",
        run: async () => {
          throw new Error("child exploded");
        },
      });
      await jobs.wait("projects");
      expect(await store.listJobs(ws.root, "projects")).toEqual([
        expect.objectContaining({ status: "failed", summary: "child exploded" }),
      ]);
      await (await store.lock(ws.root, "projects")).release();
    } finally {
      await ws.cleanup();
    }
  });

  it("stops a running job by aborting its signal and runs the stop hook", async () => {
    const { ws, store, jobs } = await setup();
    try {
      let seen: AbortSignal | undefined;
      let hook = 0;
      await jobs.start({
        root: ws.root,
        feature: "projects",
        unit: "build",
        onStop: () => {
          hook += 1;
        },
        run: (signal) =>
          new Promise<string>((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
      expect(await jobs.stop("projects")).toBe(true);
      await jobs.wait("projects");
      expect(seen?.aborted).toBe(true);
      expect(hook).toBe(1);
      expect(await store.listJobs(ws.root, "projects")).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
      expect(await jobs.stop("projects")).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("runs a unit in the foreground under the same lock and returns its value", async () => {
    const { ws, store, jobs } = await setup();
    try {
      const value = await jobs.runInline({
        root: ws.root,
        feature: "projects",
        unit: "specify",
        run: async () => 42,
      });
      expect(value).toBe(42);
      await (await store.lock(ws.root, "projects")).release();
      const lock = await store.lock(ws.root, "projects");
      await expect(
        jobs.runInline({ root: ws.root, feature: "projects", unit: "specify", run: async () => 1 }),
      ).rejects.toBeInstanceOf(FeatureLockedError);
      await lock.release();
    } finally {
      await ws.cleanup();
    }
  });
});
