import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsBoardStore } from "../src/adapters/fs-board-store.js";
import { emptyBoard } from "../src/domain/task.js";
import { tempDir } from "./helpers.js";

const card = {
  name: "add-login",
  taskId: "20260102T030405678000Z-add-login",
  lane: "coder",
  status: "queued" as const,
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-01-02T03:04:05.000Z",
  auditCount: 0,
};

describe("FsBoardStore", () => {
  it("returns undefined before the first write", async () => {
    expect(await new FsBoardStore(await tempDir()).read()).toBeUndefined();
  });

  it("round-trips a board with a schema version on disk", async () => {
    const root = await tempDir();
    const store = new FsBoardStore(root);
    await store.write({ schemaVersion: 1, tasks: [card] });
    expect((await store.read())?.tasks[0]).toEqual(card);
    const raw = JSON.parse(
      await readFile(join(root, ".alisio", "swarm", "board", "tasks.json"), "utf8"),
    );
    expect(raw.schemaVersion).toBe(1);
  });

  it("refuses to write an invalid board", async () => {
    const store = new FsBoardStore(await tempDir());
    await expect(
      store.write({ schemaVersion: 1, tasks: [{ ...card, status: "weird" as never }] }),
    ).rejects.toThrow(/status/);
  });

  it("revalidates on load and reports corruption", async () => {
    const root = await tempDir();
    const dir = join(root, ".alisio", "swarm", "board");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tasks.json"), "{not json");
    await expect(new FsBoardStore(root).read()).rejects.toThrow(/corrupt/i);
    await writeFile(join(dir, "tasks.json"), JSON.stringify({ schemaVersion: 9, tasks: [] }));
    await expect(new FsBoardStore(root).read()).rejects.toThrow(/corrupt/i);
  });

  it("serialises concurrent writes", async () => {
    const store = new FsBoardStore(await tempDir());
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.write({
          ...emptyBoard(),
          tasks: [{ ...card, auditCount: i }],
        }),
      ),
    );
    expect((await store.read())?.tasks[0]?.auditCount).toBe(9);
  });
});
