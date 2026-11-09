import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { fixture } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Store", () => {
  it("skips and reports corrupt documents instead of failing the listing", async () => {
    const f = await fixture();
    try {
      const good = await f.invoke("documents.create", { title: "Readable" });
      const corrupt = `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.json`;
      const wrongShape = `${"1".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.json`;
      await writeFile(join(f.root, corrupt), "{ not json");
      await writeFile(join(f.root, wrongShape), JSON.stringify({ id: "x" }));
      const reported: string[] = [];
      const store = new Store(f.root, (file) => reported.push(file));
      const list = await store.list();
      expect(list.map((d) => d.id)).toEqual([good.id]);
      expect(reported.sort()).toEqual([corrupt, wrongShape].sort());
    } finally {
      await f.cleanup();
    }
  });

  it("writes atomically and leaves no temporary files behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "scribe-store-"));
    roots.push(root);
    const store = new Store(root);
    await store.atomicWrite("file.bin", new Uint8Array([1, 2, 3]));
    expect(await readdir(root)).toEqual(["file.bin"]);
  });
});
