import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCacheTtlMs } from "../src/research/client.js";
import { fixtureClient } from "./helpers/scholar.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const cacheDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "thesis-scholar-"));
  dirs.push(dir);
  return dir;
};
const doi = { kind: "doi", value: "10.5555/sae.2021.014" } as const;

describe("24 h scholar resolve cache", () => {
  it("serves a repeated resolve from the cache without a request", async () => {
    const { client, network } = fixtureClient();
    client.useCache(await cacheDir());
    const first = await client.resolve(doi);
    const calls = network.calls.length;
    expect(first?.record.doi).toBeTruthy();
    expect(await client.resolve(doi)).toEqual(first);
    expect(network.calls.length).toBe(calls);
  });

  it("expires after 24 hours and refetches", async () => {
    const { client, network, clock } = fixtureClient();
    client.useCache(await cacheDir());
    await client.resolve(doi);
    const calls = network.calls.length;
    clock.time += resolveCacheTtlMs + 1;
    await client.resolve(doi);
    expect(network.calls.length).toBeGreaterThan(calls);
  });

  it("does not cache failures or misses, and works without a cache directory", async () => {
    const dir = await cacheDir();
    const { client } = fixtureClient([{ match: "api.crossref.org", status: 500 }]);
    client.useCache(dir);
    await expect(client.resolve(doi)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    const plain = fixtureClient();
    expect((await plain.client.resolve(doi))?.record.doi).toBeTruthy();
  });

  it("treats a damaged entry as a miss", async () => {
    const dir = await cacheDir();
    const { client } = fixtureClient();
    client.useCache(dir);
    await client.resolve(doi);
    const [file] = await readdir(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, file as string), "{not json");
    expect((await client.resolve(doi))?.record.doi).toBeTruthy();
  });
});
