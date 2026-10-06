import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, LockHeldError } from "../src/infrastructure/fs/lock.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

describe("feature lock", () => {
  it("creates the lock with pid and release removes it", async () => {
    ws = await tempWorkspace();
    const path = join(ws.root, "f", ".lock");
    const lock = await acquireLock(path, { pid: process.pid });
    const body = JSON.parse(await readFile(path, "utf8"));
    expect(body).toMatchObject({ pid: process.pid, host: "frontsmith" });
    expect(typeof body.startedAt).toBe("string");
    await lock.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await lock.release();
  });

  it("refuses a second holder while the first process is alive", async () => {
    ws = await tempWorkspace();
    const path = join(ws.root, ".lock");
    const first = await acquireLock(path, { pid: process.pid });
    await expect(acquireLock(path, { pid: process.pid })).rejects.toThrow(LockHeldError);
    await first.release();
  });

  it("removes a stale lock whose process is gone (ESRCH) and reports it", async () => {
    ws = await tempWorkspace();
    const path = join(ws.root, ".lock");
    await writeFile(path, JSON.stringify({ pid: 4_194_000, startedAt: "x", host: "frontsmith" }));
    const kill = (): void => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    };
    const lock = await acquireLock(path, { pid: process.pid, kill });
    expect(lock.reclaimedStale).toEqual({ pid: 4_194_000 });
    await lock.release();
  });

  it("treats EPERM as an alive owner and a corrupt file as stale", async () => {
    ws = await tempWorkspace();
    const path = join(ws.root, ".lock");
    await writeFile(path, JSON.stringify({ pid: 1, startedAt: "x", host: "frontsmith" }));
    const eperm = (): void => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    };
    await expect(acquireLock(path, { pid: process.pid, kill: eperm })).rejects.toThrow(
      LockHeldError,
    );
    await writeFile(path, "not json");
    const lock = await acquireLock(path, { pid: process.pid });
    expect(lock.reclaimedStale).toBeDefined();
    await lock.release();
  });
});
