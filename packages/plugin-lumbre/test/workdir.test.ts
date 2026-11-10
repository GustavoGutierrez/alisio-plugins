import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { syncWork } from "../src/workdir.js";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), "lmb-work-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe("work folder sync (LMB-AC-05)", () => {
  it("writes only changed files in place, deletes removed ones and keeps node_modules", async () => {
    const dir = await project();
    const first = await syncWork(dir, { "index.html": "a", "src/a.js": "1", "src/old/b.js": "2" });
    expect(first.written.sort()).toEqual(["index.html", "src/a.js", "src/old/b.js"]);
    await mkdir(join(dir, "work", "node_modules", "vite"), { recursive: true });
    await writeFile(join(dir, "work", "node_modules", "vite", "package.json"), "{}");
    const before = (await stat(join(dir, "work", "index.html"))).ino;

    const second = await syncWork(dir, { "index.html": "a", "src/a.js": "changed" });
    expect(second.written).toEqual(["src/a.js"]);
    expect(second.deleted).toEqual(["src/old/b.js"]);
    // Unchanged files are not rewritten (same inode), so watchers see only real changes.
    expect((await stat(join(dir, "work", "index.html"))).ino).toBe(before);
    expect(await readFile(join(dir, "work", "src/a.js"), "utf8")).toBe("changed");
    // The emptied folder is removed; dependencies stay.
    expect(await readdir(join(dir, "work", "src"))).toEqual(["a.js"]);
    expect(await readFile(join(dir, "work", "node_modules", "vite", "package.json"), "utf8")).toBe(
      "{}",
    );
  });

  it("rewrites a tracked file that was changed on disk behind Lumbre's back", async () => {
    const dir = await project();
    await syncWork(dir, { "index.html": "a" });
    await writeFile(join(dir, "work", "index.html"), "edited outside");
    const again = await syncWork(dir, { "index.html": "a" }, { verify: true });
    expect(again.written).toEqual(["index.html"]);
    expect(await readFile(join(dir, "work", "index.html"), "utf8")).toBe("a");
  });

  it("never follows a symlinked folder out of the work folder", async () => {
    const dir = await project();
    const outside = await project();
    await syncWork(dir, { "index.html": "a" });
    await symlink(outside, join(dir, "work", "src"));
    let code = "ok";
    try {
      await syncWork(dir, { "index.html": "a", "src/x.js": "evil" });
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("invalid_path");
    expect(await readdir(outside)).toEqual([]);
  });
});
