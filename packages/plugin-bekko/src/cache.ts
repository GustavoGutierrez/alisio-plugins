/**
 * A `fetch` replacement for the model runtime that only serves the pinned files, keeps them in a
 * content-addressed disk cache and verifies every byte. A download streams to a private temporary
 * file while it is hashed, and is renamed into place only when its size and SHA-256 match the pin,
 * so an interrupted or tampered download never becomes a cache entry. Redirects are followed by
 * hand and each hop is checked against the host allowlist BEFORE it is requested.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PinnedFile } from "./pins.js";

const MAX_REDIRECTS = 5;

/**
 * Hugging Face domains only: `huggingface.co` and `hf.co` with their subdomains (the resolve URL
 * redirects to a storage CDN such as `us.aws.cdn.hf.co`). Content is verified by digest anyway.
 */
export function isAllowedHost(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.port === "" || url.port === "443") &&
    ["huggingface.co", "hf.co"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  );
}

/** Cache directory: the host's per-plugin cache, then `ALISIO_BEKKO_CACHE_DIR`, then the home. */
export function defaultCacheDir(
  hostCache?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (hostCache) return join(hostCache, "models");
  if (env.ALISIO_BEKKO_CACHE_DIR) return env.ALISIO_BEKKO_CACHE_DIR;
  return join(homedir(), ".alisio", "cache", "bekko");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The cached bytes when the entry exists and still matches its pin, otherwise `null`. */
async function readVerified(path: string, file: PinnedFile): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (info.size === file.bytes && (await sha256File(path)) === file.sha256) {
      return await readFile(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  await rm(path, { force: true });
  return null;
}

async function request(url: URL, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedHost(current))
      throw new Error(`model download host not allowed: ${current.hostname}`);
    const response = await fetchImpl(current, {
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location)
        throw new Error(`model download redirect without a location (HTTP ${response.status})`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`model download failed (HTTP ${response.status})`);
    return response;
  }
  throw new Error("model download followed too many redirects");
}

async function download(
  file: PinnedFile,
  path: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await request(new URL(file.url), fetchImpl, signal);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== file.bytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("model download has an unexpected size");
  }
  if (!response.body) throw new Error("model download returned an empty body");
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const hash = createHash("sha256");
  let size = 0;
  try {
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    source.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > file.bytes) source.destroy(new Error("model download is larger than expected"));
      else hash.update(chunk);
    });
    await pipeline(source, createWriteStream(temp, { mode: 0o600 }));
    if (size !== file.bytes) throw new Error("model download is incomplete");
    if (hash.digest("hex") !== file.sha256)
      throw new Error("model download failed its integrity check");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return readFile(path);
}

export interface CachedFetchOptions {
  dir: string;
  files: readonly PinnedFile[];
  /** Network `fetch`; injectable for tests. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** A GET-only `fetch` for the pinned files; any other URL is refused without touching the network. */
export function createCachedFetch(options: CachedFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const byUrl = new Map(options.files.map((file) => [file.url, file]));
  const inFlight = new Map<string, Promise<Buffer>>();
  const cached = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method && init.method !== "GET") throw new Error("the model cache only supports GET");
    const file = byUrl.get(url);
    if (!file) throw new Error("model file is not pinned by this plugin version");
    let task = inFlight.get(file.sha256);
    if (!task) {
      task = (async () => {
        await mkdir(options.dir, { recursive: true, mode: 0o700 });
        const path = join(options.dir, `${file.sha256}.bin`);
        return (await readVerified(path, file)) ?? download(file, path, fetchImpl, options.signal);
      })().finally(() => inFlight.delete(file.sha256));
      inFlight.set(file.sha256, task);
    }
    const bytes = await task;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };
  return cached as typeof fetch;
}
