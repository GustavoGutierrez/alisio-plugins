import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanceStore } from "../src/engine/store.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function store(options: { indexThreshold?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sem-lance-"));
  dirs.push(dir);
  return { store: new LanceStore({ dir, ...options }), dir };
}
const signal = new AbortController().signal;
const spec = { modelId: "m@1#q8", dimensions: 3 };
const v = (...xs: number[]) => new Float32Array(xs);
const NAME = "semantic/nb-abcdefghijkl";

describe("LanceDB vector store (D8)", () => {
  it("creates, lists, merges upserts, deletes and queries with an equality filter (SEM-AC-06)", async () => {
    const { store: s, dir } = await store();
    const info = await s.ensureCollection(NAME, spec, signal);
    expect(info).toEqual({ name: NAME, ...spec, count: 0 });
    expect(await s.query(NAME, v(1, 0, 0), { topK: 3, signal })).toEqual([]);
    await s.upsert(
      NAME,
      [
        { id: "a", vector: v(1, 0, 0), text: "alpha", metadata: { source: "s1", ordinal: 0 } },
        { id: "b", vector: v(0, 1, 0), metadata: { source: "s2", ordinal: 1 } },
        { id: "c", vector: v(-1, 0, 0), metadata: { source: "s1", ordinal: 2 } },
      ],
      signal,
    );
    // Re-upserting an id replaces it (merge on id), it does not duplicate it.
    await s.upsert(
      NAME,
      [{ id: "b", vector: v(0.9, 0.1, 0), metadata: { source: "s1", ordinal: 1 } }],
      signal,
    );
    expect((await s.getCollection(NAME, signal))?.count).toBe(3);

    const all = await s.query(NAME, v(1, 0, 0), { topK: 5, signal });
    expect(all.map((m) => m.id)).toEqual(["a", "b", "c"]);
    for (const m of all) expect(m.score).toBeGreaterThanOrEqual(-1);
    for (const m of all) expect(m.score).toBeLessThanOrEqual(1);
    expect(all[0]?.score).toBeCloseTo(1, 5);
    expect(all[2]?.score).toBeCloseTo(-1, 5);
    expect(all[0]).toMatchObject({ text: "alpha", metadata: { source: "s1", ordinal: 0 } });
    expect(all[1]?.text).toBeUndefined();

    const filtered = await s.query(NAME, v(0, 1, 0), { topK: 5, filter: { source: "s2" }, signal });
    expect(filtered).toEqual([]);
    const s1 = await s.query(NAME, v(0, 1, 0), { topK: 1, filter: { source: "s1" }, signal });
    expect(s1.map((m) => m.id)).toEqual(["b"]);

    await s.delete(NAME, ["a", "missing"], signal);
    expect((await s.query(NAME, v(1, 0, 0), { topK: 5, signal })).map((m) => m.id)).toEqual([
      "b",
      "c",
    ]);

    expect((await s.listCollections("semantic/", signal)).map((c) => c.name)).toEqual([NAME]);
    expect(await s.listCollections("other/", signal)).toEqual([]);
    const sidecar = JSON.parse(await readFile(join(dir, "collections.json"), "utf8"));
    expect(sidecar.collections[NAME]).toMatchObject(spec);

    await s.dropCollection(NAME, signal);
    expect(await s.getCollection(NAME, signal)).toBeNull();
    expect(await s.query(NAME, v(1, 0, 0), { topK: 5, signal })).toEqual([]);
    expect(await s.health()).toEqual({ status: "ready" });
  });

  it("rejects an unsafe metadata key with invalid_input and writes nothing (SEM-AC-07)", async () => {
    const { store: s } = await store();
    await s.ensureCollection(NAME, spec, signal);
    await expect(
      s.upsert(
        NAME,
        [
          { id: "ok", vector: v(1, 0, 0), metadata: { source: "s1" } },
          { id: "bad", vector: v(0, 1, 0), metadata: { "a;drop": "x" } },
        ],
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await s.getCollection(NAME, signal))?.count).toBe(0);
    await expect(
      s.query(NAME, v(1, 0, 0), { topK: 1, filter: { "x' OR 1=1 --": "y" }, signal }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps quotes in filter values as data, never as a predicate", async () => {
    const { store: s } = await store();
    await s.ensureCollection(NAME, spec, signal);
    await s.upsert(NAME, [{ id: "q", vector: v(1, 0, 0), metadata: { source: "it's" } }], signal);
    expect(
      (await s.query(NAME, v(1, 0, 0), { topK: 1, filter: { source: "it's" }, signal })).length,
    ).toBe(1);
    expect(
      (await s.query(NAME, v(1, 0, 0), { topK: 1, filter: { source: "' OR '1'='1" }, signal }))
        .length,
    ).toBe(0);
  });

  it("rejects vectors of the wrong size and unsafe ids", async () => {
    const { store: s } = await store();
    await s.ensureCollection(NAME, spec, signal);
    await expect(s.upsert(NAME, [{ id: "a", vector: v(1, 0) }], signal)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(s.delete(NAME, ["a') OR (1=1"], signal)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      s.upsert("semantic/missing", [{ id: "a", vector: v(1, 0, 0) }], signal),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("builds an ANN index once the collection reaches the threshold", async () => {
    const { store: s, dir } = await store({ indexThreshold: 300 });
    await s.ensureCollection(NAME, { modelId: "m", dimensions: 8 }, signal);
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      vector: new Float32Array(Array.from({ length: 8 }, (_, d) => Math.sin(i * (d + 1)))),
    }));
    await s.upsert(NAME, records, signal);
    const sidecar = JSON.parse(await readFile(join(dir, "collections.json"), "utf8"));
    expect(sidecar.collections[NAME].indexed).toBe(true);
    const found = await s.query(NAME, records[7]!.vector, { topK: 1, signal });
    expect(found).toHaveLength(1);
  });
});

describe("two activations sharing one database directory", () => {
  it("keeps both collections when two store instances create them concurrently", async () => {
    const { store: a, dir } = await store();
    const b = new LanceStore({ dir });
    await Promise.all([
      a.ensureCollection("semantic/nb-aaaaaaaaaaaa", spec, signal),
      b.ensureCollection("semantic/nb-bbbbbbbbbbbb", spec, signal),
      a.ensureCollection("semantic/nb-cccccccccccc", spec, signal),
    ]);
    const names = (await b.listCollections("semantic/", signal)).map((c) => c.name).sort();
    expect(names).toEqual([
      "semantic/nb-aaaaaaaaaaaa",
      "semantic/nb-bbbbbbbbbbbb",
      "semantic/nb-cccccccccccc",
    ]);
  });
});
