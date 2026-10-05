import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsTaskStateStore } from "../src/adapters/fs-task-state-store.js";
import { deriveAttention } from "../src/domain/attention.js";
import { emptyTaskState, validateTaskState } from "../src/domain/taskstate.js";
import { tempDir } from "./helpers.js";

const TASK_ID = "20260102T030405678000Z-add-login";
const now = "2026-01-02T03:04:05.000Z";

describe("task state validation", () => {
  it("accepts a fresh state", () => {
    const state = emptyTaskState(TASK_ID, "add-login");
    expect(validateTaskState(state)).toEqual(state);
  });

  it("round-trips a hold, comments, bounces and a base commit", () => {
    const state = {
      ...emptyTaskState(TASK_ID, "add-login"),
      bases: { coder: "0123456789" },
      answer: { question: "Which?", text: "Email" },
      hold: { kind: "clarifying" as const, role: "coder", text: "Which database?", createdAt: now },
      comments: [{ doc: "specs/login.feature", text: "Add an example", createdAt: now }],
      bounces: { coder: 1 },
      rejections: 2,
    };
    expect(validateTaskState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([
    ["wrong schema", { schemaVersion: 2 }],
    ["bad task id", { taskId: "../x" }],
    ["bad base commit", { bases: { coder: "xyz" } }],
    ["bad base role", { bases: { "../x": "0123456789" } }],
    ["bad answer", { answer: { question: 1, text: "x" } }],
    ["bad hold kind", { hold: { kind: "weird", role: "coder", text: "x", createdAt: now } }],
    ["bad hold role", { hold: { kind: "blocked", role: "../x", text: "x", createdAt: now } }],
    ["unsafe comment doc", { comments: [{ doc: "../secret", text: "x", createdAt: now }] }],
    ["negative bounce", { bounces: { coder: -1 } }],
    ["bad bounce role", { bounces: { "../x": 1 } }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      validateTaskState({ ...emptyTaskState(TASK_ID, "add-login"), ...patch }),
    ).toThrow();
  });
});

describe("FsTaskStateStore", () => {
  it("returns undefined for an unknown task and persists updates atomically", async () => {
    const dir = await tempDir();
    const store = new FsTaskStateStore(dir);
    expect(await store.get(TASK_ID)).toBeUndefined();
    const saved = await store.update(TASK_ID, "add-login", (state) => {
      state.bases.coder = "0123456789";
    });
    expect(saved.bases.coder).toBe("0123456789");
    expect(await new FsTaskStateStore(dir).get(TASK_ID)).toEqual(saved);
    const files = await readdir(join(dir, ".alisio", "swarm", "state"));
    expect(files).toEqual([`${TASK_ID}.json`]);
  });

  it("serialises concurrent updates", async () => {
    const store = new FsTaskStateStore(await tempDir());
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        store.update(TASK_ID, "add-login", (state) => {
          state.rejections += 1;
        }),
      ),
    );
    expect((await store.get(TASK_ID))?.rejections).toBe(5);
  });

  it("lists and removes states", async () => {
    const store = new FsTaskStateStore(await tempDir());
    await store.update(TASK_ID, "add-login", () => undefined);
    expect((await store.list()).map((s) => s.taskId)).toEqual([TASK_ID]);
    await store.remove(TASK_ID);
    expect(await store.list()).toEqual([]);
    await store.remove(TASK_ID);
  });

  it("refuses a hostile task id and a corrupt file", async () => {
    const dir = await tempDir();
    const store = new FsTaskStateStore(dir);
    await expect(store.get("../escape")).rejects.toThrow(/task id/i);
    await store.update(TASK_ID, "add-login", () => undefined);
    await writeFile(join(dir, ".alisio", "swarm", "state", `${TASK_ID}.json`), "{nope");
    await expect(store.get(TASK_ID)).rejects.toThrow(/corrupt/i);
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(dir, ".alisio", "swarm", "state"))).toBe(true);
    expect(await readFile(join(dir, ".alisio", "swarm", "state", `${TASK_ID}.json`), "utf8")).toBe(
      "{nope",
    );
  });
});

const card = (status: "waiting_approval" | "blocked" | "clarifying") => ({
  name: "add-login",
  taskId: TASK_ID,
  lane: "coder",
  status,
  createdAt: now,
  updatedAt: now,
  auditCount: 0,
});

describe("attention with persisted state", () => {
  it("carries the hold text as detail", () => {
    const state = {
      ...emptyTaskState(TASK_ID, "add-login"),
      hold: { kind: "clarifying" as const, role: "coder", text: "Which database?", createdAt: now },
    };
    const items = deriveAttention(
      "demo",
      { schemaVersion: 1, tasks: [card("clarifying")] },
      new Map([[TASK_ID, state]]),
    );
    expect(items[0]).toMatchObject({ kind: "clarification", detail: "Which database?" });
  });

  it("reports a gate failure as its own kind", () => {
    const state = {
      ...emptyTaskState(TASK_ID, "add-login"),
      hold: { kind: "gate-failed" as const, role: "coder", text: "coverage 40%", createdAt: now },
    };
    const items = deriveAttention(
      "demo",
      { schemaVersion: 1, tasks: [card("blocked")] },
      new Map([[TASK_ID, state]]),
    );
    expect(items[0]).toMatchObject({
      id: "gate-failed:demo:add-login",
      kind: "gate-failed",
      actions: ["retry", "delete", "accept"],
    });
  });

  it("disables approve while per-document comments exist", () => {
    const state = {
      ...emptyTaskState(TASK_ID, "add-login"),
      comments: [{ doc: "specs/a.feature", text: "fix", createdAt: now }],
    };
    const [item] = deriveAttention(
      "demo",
      { schemaVersion: 1, tasks: [card("waiting_approval")] },
      new Map([[TASK_ID, state]]),
    );
    expect(item?.actions).toEqual(["documents", "comment", "reject"]);
    const [clean] = deriveAttention("demo", {
      schemaVersion: 1,
      tasks: [card("waiting_approval")],
    });
    expect(clean?.actions).toEqual(["documents", "approve", "reject"]);
  });
});
