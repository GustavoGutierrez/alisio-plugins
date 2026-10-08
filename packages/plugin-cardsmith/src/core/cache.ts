import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CardsmithError } from "./errors.js";

/**
 * Canonical JSON: object keys sorted recursively, compact output. `undefined`, functions, symbols,
 * non-finite numbers, class instances and cycles are rejected so hashing never depends on
 * accidental iteration order or silent coercion.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$", new Set<object>()));
}

function canonicalize(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CardsmithError("INVALID_SPEC", `Value at ${path} is not a finite number`, {
          path,
        });
      }
      return value;
    case "undefined":
      throw new CardsmithError("INVALID_SPEC", `Value at ${path} is undefined`, { path });
    case "object":
      break;
    default:
      throw new CardsmithError("INVALID_SPEC", `Value at ${path} is not JSON-serializable`, {
        path,
        type: typeof value,
      });
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new CardsmithError("INVALID_SPEC", `Value at ${path} contains a cycle`, { path });
    }
    seen.add(value);
    const result = value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CardsmithError("INVALID_SPEC", `Value at ${path} must be a plain object`, { path });
  }
  if (seen.has(value)) {
    throw new CardsmithError("INVALID_SPEC", `Value at ${path} contains a cycle`, { path });
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) {
      throw new CardsmithError("INVALID_SPEC", `Property at ${path}.${key} is undefined`, {
        path: `${path}.${key}`,
      });
    }
    result[key] = canonicalize(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

export interface CacheKeyParts {
  specJson: string;
  templateVersion: number;
  rendererVersion: string;
  fontHashes: Record<string, string>;
  paletteVersion: number;
  sizeId: string;
  locale: string;
  format: string;
  /** Content hash of the decoded input images; the path alone is not enough to key a render. */
  imagesHash?: string;
  /** Render mode discriminator, so a preview image is never served as a final one. */
  mode?: string;
}

/** SHA-256 hex of the canonical concatenation of every cache-relevant part. */
export function computeCacheKey(parts: CacheKeyParts): string {
  if (typeof parts !== "object" || parts === null) {
    throw new CardsmithError("INVALID_SPEC", "Cache key parts must be an object");
  }
  if (typeof parts.specJson !== "string" || parts.specJson.length === 0) {
    throw new CardsmithError("INVALID_SPEC", "Cache key part specJson must be a non-empty string", {
      part: "specJson",
    });
  }
  if (!Number.isInteger(parts.templateVersion)) {
    throw new CardsmithError("INVALID_SPEC", "Cache key part templateVersion must be an integer", {
      part: "templateVersion",
    });
  }
  if (typeof parts.rendererVersion !== "string" || parts.rendererVersion.length === 0) {
    throw new CardsmithError(
      "INVALID_SPEC",
      "Cache key part rendererVersion must be a non-empty string",
      { part: "rendererVersion" },
    );
  }
  if (typeof parts.fontHashes !== "object" || parts.fontHashes === null) {
    throw new CardsmithError("INVALID_SPEC", "Cache key part fontHashes must be an object", {
      part: "fontHashes",
    });
  }
  if (!Number.isInteger(parts.paletteVersion)) {
    throw new CardsmithError("INVALID_SPEC", "Cache key part paletteVersion must be an integer", {
      part: "paletteVersion",
    });
  }
  for (const part of ["sizeId", "locale", "format"] as const) {
    if (typeof parts[part] !== "string" || parts[part].length === 0) {
      throw new CardsmithError(
        "INVALID_SPEC",
        `Cache key part ${part} must be a non-empty string`,
        { part },
      );
    }
  }
  for (const part of ["imagesHash", "mode"] as const) {
    if (
      parts[part] !== undefined &&
      (typeof parts[part] !== "string" || parts[part].length === 0)
    ) {
      throw new CardsmithError(
        "INVALID_SPEC",
        `Cache key part ${part} must be a non-empty string when present`,
        { part },
      );
    }
  }
  return createHash("sha256").update(canonicalJson(parts), "utf8").digest("hex");
}

const CACHE_ENTRY_MAGIC = Uint8Array.from([0x43, 0x53, 0x48, 0x31]); // "CSH1"
const CACHE_DIGEST_BYTES = 32;
const CACHE_HEADER_BYTES = CACHE_ENTRY_MAGIC.length + CACHE_DIGEST_BYTES;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;

function assertCacheKey(key: string): void {
  if (typeof key !== "string" || !CACHE_KEY_PATTERN.test(key)) {
    throw new CardsmithError("INVALID_SPEC", "Cache key must be a 64-character sha256 hex", {
      key,
    });
  }
}

function encodeCacheEntry(payload: Uint8Array): Buffer {
  const digest = createHash("sha256").update(payload).digest();
  const entry = Buffer.alloc(CACHE_HEADER_BYTES + payload.byteLength);
  Buffer.from(CACHE_ENTRY_MAGIC).copy(entry, 0);
  digest.copy(entry, CACHE_ENTRY_MAGIC.length);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    entry,
    CACHE_HEADER_BYTES,
  );
  return entry;
}

/** Returns the payload only when magic and digest match; anything else is corruption. */
function decodeCacheEntry(raw: Buffer): Uint8Array | null {
  if (raw.byteLength < CACHE_HEADER_BYTES) return null;
  for (let index = 0; index < CACHE_ENTRY_MAGIC.length; index += 1) {
    if (raw[index] !== CACHE_ENTRY_MAGIC[index]) return null;
  }
  const payload = raw.subarray(CACHE_HEADER_BYTES);
  const digest = createHash("sha256").update(payload).digest();
  const stored = raw.subarray(CACHE_ENTRY_MAGIC.length, CACHE_HEADER_BYTES);
  if (!digest.equals(stored)) return null;
  return new Uint8Array(payload);
}

interface CacheEntryInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Byte-budgeted LRU cache of rendered artifacts. Entries carry a magic header and a sha256 of the
 * payload: corrupted entries are misses and are deleted. Writes are atomic (temporary file plus
 * rename) and eviction removes the oldest mtimes first.
 */
export class LruCache {
  readonly #dir: string;
  readonly #maxBytes: number;

  constructor(dir: string, maxBytes: number) {
    if (typeof dir !== "string" || dir.length === 0) {
      throw new CardsmithError("INVALID_SPEC", "Cache directory must be a non-empty string");
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new CardsmithError("INVALID_SPEC", "Cache budget must be a positive number", {
        maxBytes,
      });
    }
    this.#dir = resolve(dir);
    this.#maxBytes = Math.floor(maxBytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertCacheKey(key);
    const path = join(this.#dir, key);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      return null;
    }
    const payload = decodeCacheEntry(raw);
    if (payload === null) {
      await rm(path, { force: true }).catch(() => undefined);
      return null;
    }
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
    return payload;
  }

  async put(key: string, bytes: Uint8Array): Promise<string> {
    assertCacheKey(key);
    if (!(bytes instanceof Uint8Array)) {
      throw new CardsmithError("INVALID_SPEC", "Cache payload must be a Uint8Array", { key });
    }
    const entry = encodeCacheEntry(bytes);
    if (entry.byteLength > this.#maxBytes) {
      throw new CardsmithError(
        "LIMIT_EXCEEDED",
        `Cache entry of ${entry.byteLength} bytes exceeds the ${this.#maxBytes} byte budget`,
        { key, bytes: entry.byteLength, maxBytes: this.#maxBytes },
      );
    }
    const path = join(this.#dir, key);
    const temporary = join(this.#dir, `.${randomUUID()}.tmp`);
    try {
      await mkdir(this.#dir, { recursive: true });
      await writeFile(temporary, entry, { flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CardsmithError("CACHE_WRITE_FAILED", "Cache entry could not be written", {
        key,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    await this.#evict();
    return path;
  }

  async sizeBytes(): Promise<number> {
    const entries = await this.#listEntries();
    let total = 0;
    for (const entry of entries) total += entry.size;
    return total;
  }

  async #listEntries(): Promise<CacheEntryInfo[]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(this.#dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new CardsmithError("CACHE_WRITE_FAILED", "Cache directory could not be read", {
        dir: this.#dir,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const entries: CacheEntryInfo[] = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !CACHE_KEY_PATTERN.test(dirent.name)) continue;
      const path = join(this.#dir, dirent.name);
      try {
        const info = await stat(path);
        entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Raced away between listing and stat; treat as absent.
      }
    }
    return entries;
  }

  async #evict(): Promise<void> {
    const entries = await this.#listEntries();
    let total = 0;
    for (const entry of entries) total += entry.size;
    if (total <= this.#maxBytes) return;
    entries.sort(
      (a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    for (const entry of entries) {
      if (total <= this.#maxBytes) break;
      try {
        await rm(entry.path, { force: true });
        total -= entry.size;
      } catch {
        // Best-effort eviction; the next put retries.
      }
    }
  }
}
