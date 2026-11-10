import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAbort, SemanticPluginError } from "../errors.js";
import { type ModelSpec, modelDirName, modelId, totalBytes } from "./models.js";

/** Progress of a model download: per file and overall, in bytes; `fraction` is 0..1. */
export interface DownloadProgress {
  file: string;
  /** 1-based position of `file` in the snapshot. */
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  fileTotal: number;
  bytes: number;
  total: number;
  fraction: number;
}

/** The subset of `fetch` the downloader needs; injectable so tests stay offline. */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  url?: string;
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}>;

export interface DownloadOptions {
  fetcher?: Fetcher;
  onProgress?: (progress: DownloadProgress) => void;
  signal: AbortSignal;
}

const MARKER = ".verified.json";
const HOST = "https://huggingface.co";

/** Directory holding a verified snapshot. */
export const modelPath = (cacheRoot: string, spec: ModelSpec) =>
  join(cacheRoot, modelDirName(spec));

/** Where an in-progress file lives: outside the snapshot, so it is never mistaken for a model file. */
export const partialPath = (cacheRoot: string, spec: ModelSpec, file: string) =>
  join(cacheRoot, ".partial", modelDirName(spec), file.replaceAll("/", "__"));

/** Pinned, HTTPS-only URL of one file of the snapshot. */
export const fileUrl = (spec: ModelSpec, file: string) =>
  `${HOST}/${spec.repo}/resolve/${spec.revision}/${file}`;

interface Marker {
  modelId: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

/**
 * Cheap readiness check (no rehash): the verification marker names this exact snapshot and every
 * file still has its pinned size. Every digest was checked before the marker was written.
 */
export async function isModelReady(cacheRoot: string, spec: ModelSpec): Promise<boolean> {
  const dir = modelPath(cacheRoot, spec);
  let marker: Marker;
  try {
    marker = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return false;
  }
  if (marker?.modelId !== modelId(spec)) return false;
  for (const file of spec.files) {
    const recorded = marker.files?.[file.path];
    if (!recorded || recorded.sha256 !== file.sha256) return false;
    const info = await stat(join(dir, file.path)).catch(() => undefined);
    if (!info?.isFile() || info.size !== file.bytes) return false;
  }
  return true;
}

async function hashFile(path: string, hash: Hash) {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

async function* chunks(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>) {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Overall and per-file progress across several downloads (runtime tarballs, then model files), so
 * one progress bar covers the whole first-time download. Overall bytes never go backwards.
 */
export class ProgressTracker {
  private done = 0;
  private reported = 0;
  private index = 0;
  private current = { file: "", total: 0 };
  constructor(
    readonly total: number,
    readonly fileCount: number,
    private readonly onProgress?: (progress: DownloadProgress) => void,
  ) {}

  begin(file: string, fileTotal: number) {
    this.index++;
    this.current = { file, total: fileTotal };
    this.update(0);
  }

  update(fileBytes: number) {
    this.reported = Math.min(this.total, Math.max(this.reported, this.done + fileBytes));
    this.onProgress?.({
      file: this.current.file,
      fileIndex: this.index,
      fileCount: this.fileCount,
      fileBytes,
      fileTotal: this.current.total,
      bytes: this.reported,
      total: this.total,
      fraction: this.total > 0 ? this.reported / this.total : 1,
    });
  }

  end() {
    this.update(this.current.total);
    this.done += this.current.total;
  }
}

export type DigestSpec = {
  algorithm: "sha256" | "sha512";
  value: string;
  encoding: "hex" | "base64";
};

/** Streams `url` into `partial` (resuming a leftover with `Range`), then checks size and digest. */
export async function fetchVerified(
  fetcher: Fetcher,
  url: string,
  partial: string,
  expected: number,
  digest: DigestSpec,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  if (!url.startsWith("https://")) throw new SemanticPluginError("download_failed");
  let offset = (await stat(partial).catch(() => undefined))?.size ?? 0;
  if (offset >= expected) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const response = await fetcher(url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    signal,
  });
  if (!response.ok || !response.body) throw new SemanticPluginError("download_failed");
  // Redirects (to a CDN) must stay on HTTPS.
  if (response.url && !response.url.startsWith("https://"))
    throw new SemanticPluginError("download_failed");
  const hash = createHash(digest.algorithm);
  if (response.status === 206 && offset > 0) await hashFile(partial, hash);
  else offset = 0;
  const handle = await open(partial, offset > 0 ? "a" : "w", 0o600);
  let bytes = offset;
  try {
    progress(bytes);
    for await (const chunk of chunks(response.body)) {
      signal.throwIfAborted?.();
      bytes += chunk.byteLength;
      if (bytes > expected) throw new SemanticPluginError("model_corrupt");
      hash.update(chunk);
      await handle.write(chunk);
      progress(bytes);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (bytes !== expected || hash.digest(digest.encoding) !== digest.value)
    throw new SemanticPluginError("model_corrupt");
}

/** Maps a download failure to a plugin code after removing the partial file. */
export async function failDownload(
  partial: string,
  error: unknown,
  signal: AbortSignal,
): Promise<never> {
  await rm(partial, { force: true });
  if (isAbort(error) || signal.aborted) throw new SemanticPluginError("cancelled");
  if (error instanceof SemanticPluginError) throw error;
  throw new SemanticPluginError("download_failed");
}

/**
 * Downloads and verifies a pinned snapshot into `cacheRoot` (D3). Only called after an explicit
 * user action. Each file streams into `.partial/`, is checked against its pinned size and SHA-256,
 * and only then moves into the snapshot directory. A partial file left by a crash is resumed with a
 * `Range` request; a cancelled, failed or tampered download removes its partial file.
 */
export async function downloadModel(
  cacheRoot: string,
  spec: ModelSpec,
  options: DownloadOptions & { tracker?: ProgressTracker },
): Promise<{ downloaded: boolean }> {
  const { signal } = options;
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  const own = !options.tracker;
  const tracker =
    options.tracker ?? new ProgressTracker(totalBytes(spec), spec.files.length, options.onProgress);
  if (await isModelReady(cacheRoot, spec)) {
    if (own)
      for (const file of spec.files) {
        tracker.begin(file.path, file.bytes);
        tracker.end();
      }
    return { downloaded: false };
  }
  const dir = modelPath(cacheRoot, spec);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of spec.files) {
    signal.throwIfAborted?.();
    tracker.begin(file.path, file.bytes);
    const finalPath = join(dir, file.path);
    const existing = await stat(finalPath).catch(() => undefined);
    if (existing?.isFile() && existing.size === file.bytes) {
      const hash = createHash("sha256");
      await hashFile(finalPath, hash);
      if (hash.digest("hex") === file.sha256) {
        tracker.end();
        continue;
      }
    }
    await rm(finalPath, { force: true });
    const partial = partialPath(cacheRoot, spec, file.path);
    await mkdir(dirname(partial), { recursive: true, mode: 0o700 });
    try {
      await fetchVerified(
        fetcher,
        fileUrl(spec, file.path),
        partial,
        file.bytes,
        { algorithm: "sha256", value: file.sha256, encoding: "hex" },
        signal,
        (n) => tracker.update(n),
      );
    } catch (error) {
      await failDownload(partial, error, signal);
    }
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    await rename(partial, finalPath);
    tracker.end();
  }
  await rm(join(cacheRoot, ".partial", modelDirName(spec)), { recursive: true, force: true });
  await rmdir(join(cacheRoot, ".partial")).catch(() => {});
  const marker: Marker = {
    modelId: modelId(spec),
    files: Object.fromEntries(
      spec.files.map((f) => [f.path, { bytes: f.bytes, sha256: f.sha256 }]),
    ),
  };
  const temp = join(dir, `${MARKER}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(marker), { mode: 0o600 });
  await rename(temp, join(dir, MARKER));
  return { downloaded: true };
}
