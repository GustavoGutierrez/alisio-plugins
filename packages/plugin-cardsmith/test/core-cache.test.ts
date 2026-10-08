import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { type CacheKeyParts, canonicalJson, computeCacheKey, LruCache } from "../src/core/cache.js";
import { captureAsyncError, captureError, tempDir } from "./helpers.js";

const KEY_PARTS: CacheKeyParts = {
  specJson: '{"title":"Hola"}',
  templateVersion: 1,
  rendererVersion: "0.1.0",
  fontHashes: { Inter400: "aaa", PatrickHand: "bbb" },
  paletteVersion: 1,
  sizeId: "social-portrait",
  locale: "es",
  format: "png",
};

describe("canonicalJson", () => {
  it("sorts keys recursively and is stable", () => {
    const first = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const second = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(first).toBe(second);
    expect(first).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("rejects undefined, NaN, functions, class instances and cycles", () => {
    expect(captureError(() => canonicalJson({ a: undefined })).code).toBe("INVALID_SPEC");
    expect(captureError(() => canonicalJson({ a: Number.NaN })).code).toBe("INVALID_SPEC");
    expect(captureError(() => canonicalJson({ a: () => 1 })).code).toBe("INVALID_SPEC");
    expect(captureError(() => canonicalJson(new Date(0))).code).toBe("INVALID_SPEC");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(captureError(() => canonicalJson(cycle)).code).toBe("INVALID_SPEC");
  });
});

describe("computeCacheKey", () => {
  it("is stable and ignores fontHashes key order", () => {
    const first = computeCacheKey(KEY_PARTS);
    const second = computeCacheKey({
      ...KEY_PARTS,
      fontHashes: { PatrickHand: "bbb", Inter400: "aaa" },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes with any relevant part", () => {
    const base = computeCacheKey(KEY_PARTS);
    expect(computeCacheKey({ ...KEY_PARTS, sizeId: "story-vertical" })).not.toBe(base);
    expect(computeCacheKey({ ...KEY_PARTS, templateVersion: 2 })).not.toBe(base);
    expect(computeCacheKey({ ...KEY_PARTS, rendererVersion: "0.2.0" })).not.toBe(base);
    expect(computeCacheKey({ ...KEY_PARTS, fontHashes: { Inter400: "ccc" } })).not.toBe(base);
    expect(computeCacheKey({ ...KEY_PARTS, locale: "en" })).not.toBe(base);
    expect(computeCacheKey({ ...KEY_PARTS, format: "jpeg" })).not.toBe(base);
  });

  it("rejects malformed parts", () => {
    expect(captureError(() => computeCacheKey({ ...KEY_PARTS, templateVersion: 1.5 })).code).toBe(
      "INVALID_SPEC",
    );
    expect(captureError(() => computeCacheKey({ ...KEY_PARTS, specJson: "" })).code).toBe(
      "INVALID_SPEC",
    );
  });
});

describe("LruCache", () => {
  async function makeCache(maxBytes = 100_000) {
    const dir = await tempDir("cache");
    return { dir, cache: new LruCache(dir, maxBytes) };
  }

  it("round-trips bytes through atomic writes", async () => {
    const { dir, cache } = await makeCache();
    const key = computeCacheKey(KEY_PARTS);
    const payload = new Uint8Array([1, 2, 3, 255]);
    const path = await cache.put(key, payload);
    expect(path).toBe(join(dir, key));
    const loaded = await cache.get(key);
    expect(loaded).toEqual(payload);
    const entries = await readdir(dir);
    expect(entries).toEqual([key]);
  });

  it("returns null for misses and rejects malformed keys", async () => {
    const { cache } = await makeCache();
    expect(await cache.get("0".repeat(64))).toBeNull();
    const error = await captureAsyncError(() => cache.get("not-a-key"));
    expect(error.code).toBe("INVALID_SPEC");
  });

  it("evicts oldest entries until under budget", async () => {
    const { cache } = await makeCache(200);
    const first = computeCacheKey({ ...KEY_PARTS, specJson: "one" });
    const second = computeCacheKey({ ...KEY_PARTS, specJson: "two" });
    const third = computeCacheKey({ ...KEY_PARTS, specJson: "three" });
    const payload = new Uint8Array(100).fill(7);
    await cache.put(first, payload);
    await sleep(20);
    await cache.put(second, payload);
    expect(await cache.get(first)).toBeNull();
    expect(await cache.get(second)).not.toBeNull();
    await sleep(20);
    await cache.put(third, payload);
    expect(await cache.get(second)).toBeNull();
    expect(await cache.get(third)).not.toBeNull();
    expect(await cache.sizeBytes()).toBeLessThanOrEqual(200);
  });

  it("treats corrupted entries as misses and deletes them", async () => {
    const { dir, cache } = await makeCache();
    const key = computeCacheKey(KEY_PARTS);
    await cache.put(key, new Uint8Array([1, 2, 3]));
    const path = join(dir, key);
    await writeFile(path, Buffer.from("corrupted"));
    expect(await cache.get(key)).toBeNull();
    await expect(stat(path)).rejects.toThrow();
  });

  it("never leaves a partial or temporary file behind", async () => {
    const { dir, cache } = await makeCache();
    const key = computeCacheKey({ ...KEY_PARTS, specJson: "atomic" });
    await mkdir(join(dir, key), { recursive: true });
    const error = await captureAsyncError(() => cache.put(key, new Uint8Array([9])));
    expect(error.code).toBe("CACHE_WRITE_FAILED");
    const entries = await readdir(dir);
    expect(entries).toContain(key);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses entries larger than the whole budget", async () => {
    const { cache } = await makeCache(50);
    const key = computeCacheKey(KEY_PARTS);
    const error = await captureAsyncError(() => cache.put(key, new Uint8Array(100)));
    expect(error.code).toBe("LIMIT_EXCEEDED");
  });
});
