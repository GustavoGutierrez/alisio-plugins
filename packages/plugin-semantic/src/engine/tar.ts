// Streaming, allow-list tar.gz extraction for the pinned ONNX Runtime npm tarballs (owner O9).
// Rejects absolute paths, `..`, backslashes, links and device entries anywhere in the archive, caps
// entry count and sizes, and writes only the files `select` keeps.
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import { isAbort, SemanticPluginError } from "../errors.js";

export interface ExtractLimits {
  signal: AbortSignal;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
export type Extracted = Record<string, { bytes: number; sha256: string }>;

const corrupt = (): never => {
  throw new SemanticPluginError("model_corrupt");
};

/** Archive path checks applied to every entry, selected or not. */
export function safeEntryPath(name: string): string {
  const path = name.replace(/\/+$/, "");
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) corrupt();
  if (/^[A-Za-z]:/.test(path)) corrupt();
  for (const part of path.split("/")) if (part === "" || part === "." || part === "..") corrupt();
  return path;
}

const field = (block: Buffer, start: number, length: number) => {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};
const octal = (block: Buffer, start: number, length: number) => {
  const text = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) corrupt();
  return text ? Number.parseInt(text, 8) : 0;
};

function checksumOk(block: Buffer) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] as number);
  return sum === octal(block, 148, 8);
}

function paxPath(data: Buffer): string | undefined {
  let at = 0;
  let path: string | undefined;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) corrupt();
    const length = Number(data.toString("utf8", at, space));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) corrupt();
    const record = data.toString("utf8", space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/**
 * Extracts `archive` (gzip + ustar/pax) into `dest`. `select` maps an archive path to the path to
 * write under `dest`, or null to skip. Returns size and SHA-256 of every written file.
 */
export async function extractTarGz(
  archive: string,
  dest: string,
  select: (path: string) => string | null,
  limits: ExtractLimits,
): Promise<Extracted> {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxFileBytes = limits.maxFileBytes ?? 256 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 400 * 1024 * 1024;
  const out: Extracted = {};
  let buffer: Buffer = Buffer.alloc(0);
  let entries = 0;
  let total = 0;
  let ended = false;
  let nextPath: string | undefined;
  // Current entry state.
  let remaining = 0;
  let padding = 0;
  let meta: Buffer[] | undefined;
  let metaKind: "x" | "L" | undefined;
  let target: { handle: FileHandle; hash: Hash; path: string; bytes: number } | undefined;

  const finishEntry = async () => {
    if (target) {
      await target.handle.close();
      out[target.path] = { bytes: target.bytes, sha256: target.hash.digest("hex") };
      target = undefined;
    }
    if (meta) {
      const data = Buffer.concat(meta);
      nextPath = metaKind === "x" ? (paxPath(data) ?? nextPath) : field(data, 0, data.length);
      meta = undefined;
      metaKind = undefined;
    }
  };

  const startEntry = async (block: Buffer) => {
    if (block.every((b) => b === 0)) {
      ended = true;
      return;
    }
    if (!checksumOk(block)) corrupt();
    if (++entries > maxEntries) corrupt();
    const type = String.fromCharCode(block[156] as number) || "0";
    const size = octal(block, 124, 12);
    const prefix = field(block, 345, 155);
    const headerName = prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100);
    remaining = size;
    padding = (512 - (size % 512)) % 512;
    if (type === "x" || type === "L") {
      if (size > 64 * 1024) corrupt();
      meta = [];
      metaKind = type;
      return;
    }
    if (type === "g") return;
    const name = nextPath ?? headerName;
    nextPath = undefined;
    const path = safeEntryPath(name);
    if (type === "5") return;
    if (type !== "0" && type !== "\0" && type !== "7") corrupt(); // links, devices, fifos
    if (size > maxFileBytes) corrupt();
    const keep = select(path);
    if (keep === null) return;
    const relative = safeEntryPath(keep);
    total += size;
    if (total > maxTotalBytes) corrupt();
    const file = join(dest, relative);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    target = {
      handle: await open(file, "wx", 0o600),
      hash: createHash("sha256"),
      path: relative,
      bytes: 0,
    };
  };

  try {
    limits.signal.throwIfAborted();
    const source = createReadStream(archive).pipe(createGunzip());
    for await (const chunk of source as AsyncIterable<Buffer>) {
      limits.signal.throwIfAborted();
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (!ended) {
        if (remaining > 0) {
          if (buffer.length === 0) break;
          const piece = buffer.subarray(0, Math.min(remaining, buffer.length));
          buffer = buffer.subarray(piece.length);
          remaining -= piece.length;
          if (meta) meta.push(Buffer.from(piece));
          else if (target) {
            target.hash.update(piece);
            target.bytes += piece.length;
            await target.handle.write(piece);
          }
          if (remaining > 0) break;
          await finishEntry();
          continue;
        }
        if (padding > 0) {
          if (buffer.length < padding) break;
          buffer = buffer.subarray(padding);
          padding = 0;
          continue;
        }
        if (buffer.length < 512) break;
        const block = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        await startEntry(block);
        if (remaining === 0 && !ended) await finishEntry();
      }
      if (ended) break;
    }
    if (!ended || remaining > 0) corrupt();
    return out;
  } catch (error) {
    await target?.handle.close().catch(() => {});
    if (isAbort(error) || limits.signal.aborted) throw new SemanticPluginError("cancelled");
    if (error instanceof SemanticPluginError) throw error;
    throw new SemanticPluginError("model_corrupt");
  }
}
