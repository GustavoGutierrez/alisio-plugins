import { createHash } from "node:crypto";
import type { Fetcher } from "../src/engine/download.js";
import type { ModelSpec } from "../src/engine/models.js";

export const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A tiny pinned "model" whose files are served by `fakeFetcher`. */
export function fakeModel(contents: Record<string, Buffer>, overrides: Partial<ModelSpec> = {}) {
  const spec: ModelSpec = {
    key: "e5-small",
    label: "fake",
    repo: "Fake/model",
    baseModel: "fake/model",
    license: "MIT",
    revision: "0123456789abcdef0123456789abcdef01234567",
    dtype: "q8",
    dimensions: 4,
    maxTokens: 16,
    prefixes: { query: "query: ", document: "passage: " },
    files: Object.entries(contents).map(([path, data]) => ({
      path,
      bytes: data.length,
      sha256: sha(data),
    })),
    ...overrides,
  };
  return spec;
}

export interface FetchLog {
  url: string;
  range?: string;
}

/**
 * Serves `served` (by path suffix) in `chunk`-byte pieces, honoring `Range: bytes=n-`. `failAfter`
 * aborts a body after that many bytes with a network error (an interrupted download).
 */
export function fakeFetcher(
  served: Record<string, Buffer>,
  options: { chunk?: number; failAfter?: Record<string, number>; ignoreRange?: boolean } = {},
) {
  const log: FetchLog[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const range = init.headers.Range;
    log.push({ url, ...(range ? { range } : {}) });
    const path = Object.keys(served).find((p) => url.endsWith(`/${p}`));
    if (!path) return { ok: false, status: 404, body: null };
    const data = served[path] as Buffer;
    const start = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const size = options.chunk ?? 1024;
    const failAt = options.failAfter?.[path];
    async function* body() {
      for (let at = start; at < data.length; at += size) {
        init.signal.throwIfAborted();
        if (failAt !== undefined && at - start >= failAt) throw new TypeError("network down");
        await new Promise((r) => setImmediate(r));
        yield new Uint8Array(data.subarray(at, Math.min(at + size, data.length)));
      }
    }
    return { ok: true, status: start > 0 ? 206 : 200, url, body: body() };
  };
  return { fetcher, log };
}
