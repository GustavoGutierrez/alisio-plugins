import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  atomicWrite,
  ensureIgnoreEntries,
  Mutex,
  readText,
  resolveContained,
} from "../src/storage.js";
import { tempDir } from "./helpers.js";

describe("atomicWrite", () => {
  it("writes a private file and leaves no temp files", async () => {
    const dir = await tempDir();
    const file = join(dir, "a", "b.json");
    await atomicWrite(file, "{}\n");
    expect(await readFile(file, "utf8")).toBe("{}\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "a"))).toEqual(["b.json"]);
  });

  it("replaces the previous content and cleans up when the rename fails", async () => {
    const dir = await tempDir();
    const file = join(dir, "x");
    await atomicWrite(file, "one");
    await atomicWrite(file, "two");
    expect(await readText(file)).toBe("two");
    await mkdir(join(dir, "taken"));
    await expect(atomicWrite(join(dir, "taken"), "nope")).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a missing file as undefined", async () => {
    expect(await readText(join(await tempDir(), "missing"))).toBeUndefined();
  });
});

describe("resolveContained", () => {
  it("resolves plain relative paths, existing or not", async () => {
    const root = await tempDir();
    expect(await resolveContained(root, "a/b.md")).toBe(join(root, "a", "b.md"));
  });

  it("rejects traversal", async () => {
    const root = await tempDir();
    await expect(resolveContained(root, "../x")).rejects.toThrow(/relative path/i);
  });

  it("rejects a symlink that leaves the root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await symlink(outside, join(root, "link"));
    await expect(resolveContained(root, "link/file.txt")).rejects.toThrow(/symlink/i);
  });

  it("allows a symlink that stays inside the root", async () => {
    const root = await tempDir();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await resolveContained(root, "alias/file.txt")).toBe(join(root, "alias", "file.txt"));
  });
});

describe("Mutex", () => {
  it("runs tasks one at a time in order, even after a failure", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push("slow");
    });
    const failing = mutex.run(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const last = mutex.run(async () => {
      order.push("last");
      return 7;
    });
    await slow;
    await expect(failing).rejects.toThrow("boom");
    expect(await last).toBe(7);
    expect(order).toEqual(["slow", "failing", "last"]);
  });
});

describe("ensureIgnoreEntries", () => {
  it("appends missing entries once", async () => {
    const dir = await tempDir();
    const file = join(dir, ".gitignore");
    await writeFile(file, "node_modules/");
    expect(await ensureIgnoreEntries(file, [".alisio/swarm/", ".worktrees/"])).toBe(true);
    expect(await ensureIgnoreEntries(file, [".alisio/swarm/", ".worktrees/"])).toBe(false);
    expect(await readFile(file, "utf8")).toBe("node_modules/\n.alisio/swarm/\n.worktrees/\n");
  });

  it("creates the file when absent", async () => {
    const file = join(await tempDir(), ".gitignore");
    await ensureIgnoreEntries(file, [".worktrees/"]);
    expect(await readFile(file, "utf8")).toBe(".worktrees/\n");
  });
});
