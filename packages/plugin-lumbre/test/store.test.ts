import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { MAX_REVISIONS, ProjectStore } from "../src/store.js";

const roots: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), "lmb-store-"));
  roots.push(root);
  return new ProjectStore(root);
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const meta = (s: ProjectStore) =>
  s.create(
    { title: "Bakery", stack: "vanilla", tailwind: false, model: null },
    {
      "index.html": "<h1>Hi</h1>",
      "styles.css": "h1{}",
    },
  );

describe("project store (LMB-AC-04)", () => {
  it("keeps one folder per project with content-addressed blobs and revision manifests", async () => {
    const s = await store();
    const p = await meta(s);
    const dir = join(s.root, "projects", p.id);
    expect((await readdir(dir)).sort()).toEqual(["blobs", "meta.json", "revisions"]);
    expect((await readdir(join(dir, "blobs"))).length).toBe(2);
    const rev = await s.commit(
      p.id,
      { "index.html": "<h1>Hi</h1>", "styles.css": "h2{}" },
      {
        summary: "Change",
        kind: "proposal",
      },
    );
    // The unchanged file shares its blob: three blobs for four file versions.
    expect((await readdir(join(dir, "blobs"))).length).toBe(3);
    expect(await s.files(p.id, rev.id)).toEqual({
      "index.html": "<h1>Hi</h1>",
      "styles.css": "h2{}",
    });
    expect(s.get(p.id)?.head).toBe(rev.id);
    expect(s.get(p.id)?.revisions.map((r) => r.kind)).toEqual(["initial", "proposal"]);
    const mode = (await stat(join(dir, "meta.json"))).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("loads each project on its own: a corrupt one is listed as damaged and the others work", async () => {
    const s = await store();
    const good = await meta(s);
    const bad = await meta(s);
    await writeFile(join(s.root, "projects", bad.id, "meta.json"), "{not json");
    const before = await readFile(join(s.root, "projects", good.id, "meta.json"), "utf8");
    const fresh = new ProjectStore(s.root);
    const { projects, damaged } = await fresh.load();
    expect(projects.map((p) => p.id)).toEqual([good.id]);
    expect(damaged).toEqual([bad.id]);
    // Activation rewrites nothing.
    expect(await readFile(join(s.root, "projects", good.id, "meta.json"), "utf8")).toBe(before);
    expect(await fresh.files(good.id, fresh.get(good.id)?.head ?? "")).toMatchObject({
      "index.html": "<h1>Hi</h1>",
    });
    await fresh.remove(bad.id);
    expect((await readdir(join(s.root, "projects"))).sort()).toEqual([good.id]);
  });

  it("refuses a blob whose content does not match its address", async () => {
    const s = await store();
    const p = await meta(s);
    const blobs = join(s.root, "projects", p.id, "blobs");
    const [first] = await readdir(blobs);
    await writeFile(join(blobs, first as string), "tampered");
    const fresh = new ProjectStore(s.root);
    await fresh.load();
    let code = "ok";
    try {
      await fresh.files(p.id, fresh.get(p.id)?.head ?? "");
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("damaged_project");
  });

  it("prunes old revisions and their unreferenced blobs", async () => {
    const s = await store();
    const p = await meta(s);
    for (let i = 0; i < MAX_REVISIONS + 3; i++)
      await s.commit(p.id, { "index.html": `<h1>${i}</h1>` }, { summary: `r${i}`, kind: "manual" });
    const m = s.get(p.id);
    expect(m?.revisions.length).toBe(MAX_REVISIONS);
    const dir = join(s.root, "projects", p.id);
    expect((await readdir(join(dir, "revisions"))).length).toBe(MAX_REVISIONS);
    expect((await readdir(join(dir, "blobs"))).length).toBe(MAX_REVISIONS);
  });

  it("stores chat, proposal and snapshot per project, atomically", async () => {
    const s = await store();
    const p = await meta(s);
    await s.writeJson(p.id, "chat", [{ id: "1", role: "user", text: "hi", at: 1 }]);
    expect(await s.readJson(p.id, "chat", [])).toEqual([
      { id: "1", role: "user", text: "hi", at: 1 },
    ]);
    expect(await s.readJson(p.id, "proposal", null)).toBeNull();
    await s.deleteJson(p.id, "proposal");
    const left = await readdir(join(s.root, "projects", p.id));
    expect(left.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("updates metadata without touching other projects", async () => {
    const s = await store();
    const a = await meta(s);
    const b = await meta(s);
    const bBefore = await readFile(join(s.root, "projects", b.id, "meta.json"), "utf8");
    await s.update(a.id, { title: "Renamed", archived: true });
    expect(s.get(a.id)?.title).toBe("Renamed");
    expect(await readFile(join(s.root, "projects", b.id, "meta.json"), "utf8")).toBe(bBefore);
  });
});
