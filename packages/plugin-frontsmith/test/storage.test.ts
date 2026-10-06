import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  ensureIgnoreEntries,
  Mutex,
  readText,
  resolveContained,
} from "../src/infrastructure/fs/storage.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

describe("atomicWrite", () => {
  it("writes a private file and creates parent directories", async () => {
    ws = await tempWorkspace();
    const target = join(ws.root, "a", "b", "state.json");
    await atomicWrite(target, "{}\n");
    expect(await readFile(target, "utf8")).toBe("{}\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ws.root, "a"))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(ws.root, "a", "b"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("removes a stale leftover temp file on the next write but not a fresh one", async () => {
    ws = await tempWorkspace();
    const dir = join(ws.root, "d");
    await mkdir(dir);
    const stale = join(dir, ".11111111-1111-4111-8111-111111111111.tmp");
    const fresh = join(dir, ".22222222-2222-4222-8222-222222222222.tmp");
    const unrelated = join(dir, ".keep.tmp");
    await writeFile(stale, "x");
    await writeFile(fresh, "y");
    await writeFile(unrelated, "z");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);
    await atomicWrite(join(dir, "f.json"), "1");
    const names = await readdir(dir);
    expect(names).not.toContain(".11111111-1111-4111-8111-111111111111.tmp");
    expect(names).toContain(".22222222-2222-4222-8222-222222222222.tmp");
    expect(names).toContain(".keep.tmp");
  });

  it("leaves the target untouched and cleans the temp file when the rename fails", async () => {
    // Renaming a file over a non-empty directory fails on every platform.
    ws = await tempWorkspace({ "t/file.json/inner.txt": "original" });
    const target = join(ws.root, "t", "file.json");
    await expect(atomicWrite(target, "replacement")).rejects.toThrow();
    expect(await readFile(join(target, "inner.txt"), "utf8")).toBe("original");
    expect((await readdir(join(ws.root, "t"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readText", () => {
  it("returns undefined for a missing file and propagates other errors", async () => {
    ws = await tempWorkspace({ "a.txt": "hi" });
    expect(await readText(join(ws.root, "a.txt"))).toBe("hi");
    expect(await readText(join(ws.root, "missing.txt"))).toBeUndefined();
    await expect(readText(ws.root)).rejects.toThrow();
  });
});

describe("resolveContained", () => {
  it("resolves ordinary relative paths, existing or not", async () => {
    ws = await tempWorkspace({ "src/a.ts": "x" });
    expect(await resolveContained(ws.root, "src/a.ts")).toBe(join(ws.root, "src", "a.ts"));
    expect(await resolveContained(ws.root, "new/dir/file.json")).toBe(
      join(ws.root, "new", "dir", "file.json"),
    );
  });

  it("refuses parent traversal, NUL, backslash, absolute and empty paths", async () => {
    ws = await tempWorkspace();
    for (const bad of ["../x", "a/../../x", "a\u0000b", "a\\b", "/etc/passwd", "", "a//b/../.."])
      await expect(resolveContained(ws.root, bad)).rejects.toThrow();
  });

  it("refuses a symlink that leads outside the root", async () => {
    ws = await tempWorkspace({ "inside.txt": "ok" });
    const outside = await tempWorkspace({ "secret.txt": "s" });
    try {
      await symlink(outside.root, join(ws.root, "link"));
      await expect(resolveContained(ws.root, "link/secret.txt")).rejects.toThrow(/symlink/);
      await expect(resolveContained(ws.root, "link/new.txt")).rejects.toThrow(/symlink/);
      await symlink(join(ws.root, "inside.txt"), join(ws.root, "ok-link"));
      await expect(resolveContained(ws.root, "ok-link")).resolves.toBe(join(ws.root, "ok-link"));
    } finally {
      await outside.cleanup();
    }
  });
});

describe("Mutex", () => {
  it("serialises tasks and survives a failing task", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const failing = mutex.run(async () => {
      order.push("fail");
      throw new Error("boom");
    });
    const last = mutex.run(async () => {
      order.push("last");
      return 7;
    });
    await slow;
    await expect(failing).rejects.toThrow("boom");
    expect(await last).toBe(7);
    expect(order).toEqual(["slow", "fail", "last"]);
  });
});

describe("ensureIgnoreEntries", () => {
  it("appends only missing lines and is idempotent", async () => {
    ws = await tempWorkspace({ ".gitignore": "node_modules" });
    const file = join(ws.root, ".gitignore");
    expect(await ensureIgnoreEntries(file, [".alisio/frontsmith/"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("node_modules\n.alisio/frontsmith/\n");
    expect(await ensureIgnoreEntries(file, [".alisio/frontsmith/", "node_modules"])).toBe(false);
  });

  it("creates the file when absent", async () => {
    ws = await tempWorkspace();
    const file = join(ws.root, ".gitignore");
    expect(await ensureIgnoreEntries(file, ["a"])).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\n");
  });
});
