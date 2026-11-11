import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCachedFetch, defaultCacheDir, isAllowedHost } from "../src/cache.js";
import { VARIANTS } from "../src/pins.js";

const body = Buffer.from("pinned model bytes");
const file = {
  url: "https://huggingface.co/org/model/resolve/abc/onnx_browser/model.onnx",
  bytes: body.length,
  sha256: createHash("sha256").update(body).digest("hex"),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bekko-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Call = { url: string; redirect: string | undefined };
function network(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route();
  }) as typeof fetch;
  return { impl, calls };
}

describe("cached fetch", () => {
  it("downloads a pinned file once, verifies it and serves it from disk", async () => {
    const net = network({ [file.url]: () => new Response(body) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    const first = await cached(file.url);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(body);
    const second = await cached(file.url);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(body);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.redirect).toBe("manual");
    expect(await readdir(dir)).toEqual([`${file.sha256}.bin`]);
  });

  it("deduplicates concurrent requests for the same file", async () => {
    const net = network({ [file.url]: () => new Response(body) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await Promise.all([cached(file.url), cached(file.url), cached(file.url)]);
    expect(net.calls).toHaveLength(1);
  });

  it("refuses a URL that is not pinned without touching the network", async () => {
    const net = network({});
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached("https://huggingface.co/evil/model.onnx")).rejects.toThrow(/not pinned/);
    await expect(cached(file.url, { method: "POST" })).rejects.toThrow(/GET/);
    expect(net.calls).toHaveLength(0);
  });

  it("rejects tampered bytes and leaves no cache entry", async () => {
    const tampered = Buffer.from("pinned model byteZ");
    const net = network({ [file.url]: () => new Response(tampered) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached(file.url)).rejects.toThrow(/integrity/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a response larger than the pin", async () => {
    const net = network({ [file.url]: () => new Response(Buffer.concat([body, body])) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached(file.url)).rejects.toThrow(/size|larger/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects an HTTP error", async () => {
    const net = network({ [file.url]: () => new Response("nope", { status: 404 }) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached(file.url)).rejects.toThrow(/HTTP 404/);
  });

  it("follows a redirect to the Hugging Face CDN", async () => {
    const cdn = "https://cas-bridge.xethub.hf.co/xet-bridge/abc?sig=1";
    const net = network({
      [file.url]: () => new Response(null, { status: 302, headers: { location: cdn } }),
      [cdn]: () => new Response(body),
    });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached(file.url)).resolves.toBeInstanceOf(Response);
    expect(net.calls.map((c) => c.url)).toEqual([file.url, cdn]);
  });

  it("refuses a redirect to another host before requesting it", async () => {
    const net = network({
      [file.url]: () =>
        new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } }),
    });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await expect(cached(file.url)).rejects.toThrow(/host not allowed/);
    expect(net.calls).toHaveLength(1);
  });

  it("replaces a corrupted cache entry with a fresh download", async () => {
    await writeFile(join(dir, `${file.sha256}.bin`), "corrupted!!!!!!!!!");
    const net = network({ [file.url]: () => new Response(body) });
    const cached = createCachedFetch({ dir, files: [file], fetchImpl: net.impl });
    await cached(file.url);
    expect(net.calls).toHaveLength(1);
    expect(await readFile(join(dir, `${file.sha256}.bin`))).toEqual(body);
  });
});

describe("hosts and directories", () => {
  it("allows only HTTPS Hugging Face hosts", () => {
    expect(isAllowedHost(new URL("https://huggingface.co/x"))).toBe(true);
    expect(isAllowedHost(new URL("https://cas-bridge.xethub.hf.co/x"))).toBe(true);
    expect(isAllowedHost(new URL("https://us.aws.cdn.hf.co/x"))).toBe(true);
    expect(isAllowedHost(new URL("https://evilhf.co/x"))).toBe(false);
    expect(isAllowedHost(new URL("http://huggingface.co/x"))).toBe(false);
    expect(isAllowedHost(new URL("https://huggingface.co.evil.example/x"))).toBe(false);
    expect(isAllowedHost(new URL("https://user:pw@huggingface.co/x"))).toBe(false);
    expect(isAllowedHost(new URL("https://huggingface.co:8443/x"))).toBe(false);
  });

  it("prefers the host cache directory, then the environment", () => {
    expect(defaultCacheDir("/host/cache", {})).toBe(join("/host/cache", "models"));
    expect(defaultCacheDir(undefined, { ALISIO_BEKKO_CACHE_DIR: "/custom" })).toBe("/custom");
    expect(defaultCacheDir(undefined, {})).toMatch(/bekko$/);
  });

  it("pins immutable revisions with SHA-256 digests for every variant file", () => {
    for (const pin of Object.values(VARIANTS)) {
      expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.files.map((f) => f.url.split("/").pop())).toEqual([
        "manifest.json",
        "tokenizer.json",
        "model.onnx",
      ]);
      for (const f of pin.files) {
        expect(f.url).toContain(`/resolve/${pin.revision}/onnx_browser/`);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
