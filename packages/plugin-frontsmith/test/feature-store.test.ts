import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeatureLockedError } from "../src/application/ports/feature-store.js";
import { createFeatureState } from "../src/domain/state/feature-state.js";
import { NewerSchemaError } from "../src/domain/state/migrations.js";
import { FsFeatureStore } from "../src/infrastructure/fs/feature-store.js";
import { tempWorkspace } from "./helpers/workspace.js";

const NOW = "2026-10-06T12:00:00.000Z";
const fresh = (feature = "projects") =>
  createFeatureState({ feature, intent: "list projects", level: "L2", mode: "build", now: NOW });
const statePath = (root: string, feature = "projects") =>
  join(root, ".alisio", "frontsmith", "features", feature, "state.json");

describe("FsFeatureStore", () => {
  it("creates, reads and lists features, writing canonical JSON", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      expect(await store.list(ws.root)).toEqual([]);
      expect(await store.read(ws.root, "projects")).toBeUndefined();
      await store.create(ws.root, fresh());
      await store.create(ws.root, fresh("alpha"));
      expect(await store.list(ws.root)).toEqual(["alpha", "projects"]);
      const opened = await store.read(ws.root, "projects");
      expect(opened).toMatchObject({
        readOnly: false,
        state: { feature: "projects", phase: "intake" },
      });
      const text = await readFile(statePath(ws.root), "utf8");
      expect(text.endsWith("}\n")).toBe(true);
      expect(Object.keys(JSON.parse(text))).toEqual([...Object.keys(JSON.parse(text))].sort());
    } finally {
      await ws.cleanup();
    }
  });

  it("refuses a duplicate feature and an invalid id", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await expect(store.create(ws.root, fresh())).rejects.toThrow(/already exists/);
      await expect(store.read(ws.root, "../escape")).rejects.toThrow(/Invalid feature/);
      await expect(store.create(ws.root, { ...fresh(), feature: "Bad Name" })).rejects.toThrow(
        /Invalid feature/,
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("serialises concurrent updates and stamps updatedAt", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.update(
            ws.root,
            "projects",
            (d) => {
              d.counters.repairRounds += 1;
            },
            `2026-10-06T12:00:${String(i).padStart(2, "0")}.000Z`,
          ),
        ),
      );
      const { state } = (await store.read(ws.root, "projects"))!;
      expect(state.counters.repairRounds).toBe(20);
      expect(state.updatedAt).toMatch(/^2026-10-06T12:00:\d\d/);
    } finally {
      await ws.cleanup();
    }
  });

  it("does not write when the mutation throws or leaves an invalid state", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await expect(
        store.update(
          ws.root,
          "projects",
          () => {
            throw new Error("nope");
          },
          NOW,
        ),
      ).rejects.toThrow("nope");
      await expect(
        store.update(
          ws.root,
          "projects",
          (d) => {
            (d as { phase: string }).phase = "dreaming";
          },
          NOW,
        ),
      ).rejects.toThrow(/Invalid state/);
      expect((await store.read(ws.root, "projects"))!.state.phase).toBe("intake");
    } finally {
      await ws.cleanup();
    }
  });

  it("opens a newer schemaVersion read-only and refuses every update (spec 8.3)", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      const raw = JSON.parse(await readFile(statePath(ws.root), "utf8"));
      await writeFile(
        statePath(ws.root),
        JSON.stringify({ ...raw, schemaVersion: 2, futureField: true }),
      );
      const opened = await store.read(ws.root, "projects");
      expect(opened).toMatchObject({ readOnly: true, version: 2, state: { feature: "projects" } });
      await expect(store.update(ws.root, "projects", () => undefined, NOW)).rejects.toBeInstanceOf(
        NewerSchemaError,
      );
      await expect(store.update(ws.root, "projects", () => undefined, NOW)).rejects.toThrow(
        "State written by a newer Frontsmith (schemaVersion 2); upgrade the plugin",
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("reports a corrupt state file instead of crashing", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await writeFile(statePath(ws.root), "{ not json");
      await expect(store.read(ws.root, "projects")).rejects.toThrow(/state\.json/);
    } finally {
      await ws.cleanup();
    }
  });

  it("records attempts with increasing sequence numbers and merges the final status", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      const sink = store.attempts(ws.root, "projects");
      const a = await sink.begin({
        kind: "child",
        role: "specifier",
        agent: "fs-specifier",
        status: "running",
        startedAt: NOW,
      });
      const b = await sink.begin({ kind: "gate", status: "running", startedAt: NOW });
      expect([a, b]).toEqual([1, 2]);
      await sink.finish(a, { status: "completed", endedAt: NOW, usage: { input: 1, output: 2 } });
      const list = await store.listAttempts(ws.root, "projects");
      expect(list).toEqual([
        expect.objectContaining({
          seq: 1,
          status: "completed",
          usage: { input: 1, output: 2 },
          agent: "fs-specifier",
        }),
        expect.objectContaining({ seq: 2, status: "running", kind: "gate" }),
      ]);
      expect((await store.read(ws.root, "projects"))!.state.attemptSeq).toBe(2);
    } finally {
      await ws.cleanup();
    }
  });

  it("marks attempts of a dead job as interrupted on resume and clears the stale job", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      const sink = store.attempts(ws.root, "projects");
      await sink.begin({ kind: "child", status: "running", startedAt: NOW });
      await sink.begin({ kind: "child", status: "completed", startedAt: NOW });
      await store.update(
        ws.root,
        "projects",
        (d) => {
          d.job = { id: "job-1", unit: "build", startedAt: NOW, ownerPid: 2 ** 22 + 12345 };
        },
        NOW,
      );
      expect(await store.recoverInterrupted(ws.root, "projects", NOW)).toBe(1);
      const list = await store.listAttempts(ws.root, "projects");
      expect(list.map((a) => a.status)).toEqual(["interrupted", "completed"]);
      expect((await store.read(ws.root, "projects"))!.state.job).toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });

  it("keeps running attempts of a live owner", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await store
        .attempts(ws.root, "projects")
        .begin({ kind: "child", status: "running", startedAt: NOW });
      await store.update(
        ws.root,
        "projects",
        (d) => {
          d.job = { id: "job-1", unit: "build", startedAt: NOW, ownerPid: process.pid };
        },
        NOW,
      );
      expect(await store.recoverInterrupted(ws.root, "projects", NOW)).toBe(0);
      expect((await store.read(ws.root, "projects"))!.state.job?.id).toBe("job-1");
    } finally {
      await ws.cleanup();
    }
  });

  it("allows one lock per feature and reports contention with the owner", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      const first = await store.lock(ws.root, "projects");
      const second = store.lock(ws.root, "projects");
      await expect(second).rejects.toBeInstanceOf(FeatureLockedError);
      await expect(store.lock(ws.root, "projects")).rejects.toThrow(/\/frontsmith:stop projects/);
      await first.release();
      const third = await store.lock(ws.root, "projects");
      await third.release();
    } finally {
      await ws.cleanup();
    }
  });

  it("stores and lists job records", async () => {
    const ws = await tempWorkspace();
    try {
      const store = new FsFeatureStore();
      await store.create(ws.root, fresh());
      await store.writeJob(ws.root, {
        id: "job-1",
        feature: "projects",
        unit: "build",
        status: "running",
        startedAt: NOW,
        ownerPid: 1,
      });
      await store.writeJob(ws.root, {
        id: "job-1",
        feature: "projects",
        unit: "build",
        status: "completed",
        startedAt: NOW,
        endedAt: NOW,
        ownerPid: 1,
        summary: "done",
      });
      expect(await store.listJobs(ws.root, "projects")).toEqual([
        expect.objectContaining({ id: "job-1", status: "completed", summary: "done" }),
      ]);
    } finally {
      await ws.cleanup();
    }
  });
});
