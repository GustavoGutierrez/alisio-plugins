// Minimal ZIP reader for Office files (.docx, .pptx, .xlsx): central directory + `node:zlib`
// inflateRaw. Zip-bomb guards: entry count, total declared size, per-entry size (the inflate itself
// is capped at the declared size) and compression ratio. No ZIP64, no encryption.
import { inflateRawSync } from "node:zlib";
import { SemanticPluginError } from "../errors.js";

export interface ZipLimits {
  maxEntries: number;
  maxTotal: number;
  maxEntry: number;
  /** Uncompressed/compressed ratio allowed for entries larger than 1 MiB. */
  maxRatio: number;
}
/** §7.3: at most 1 000 entries and 50 MiB uncompressed (spec numbers, kept for .docx). */
export const DOCX_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxTotal: 50 * 1024 * 1024,
  maxEntry: 50 * 1024 * 1024,
  maxRatio: 200,
};
/** Presentations and workbooks hold more parts (slides, notes, media): wider count and total. */
export const OFFICE_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotal: 200 * 1024 * 1024,
  maxEntry: 50 * 1024 * 1024,
  maxRatio: 200,
};

const bad = (): never => {
  throw new SemanticPluginError("zip_invalid");
};

interface Entry {
  method: number;
  flags: number;
  compressed: number;
  uncompressed: number;
  local: number;
}

export class ZipArchive {
  private readonly entries = new Map<string, Entry>();
  private readonly zip: Buffer;
  private readonly limits: ZipLimits;

  constructor(zip: Buffer, limits: ZipLimits) {
    this.zip = zip;
    this.limits = limits;
    if (zip.length < 22) bad();
    const searchFrom = Math.max(0, zip.length - 65_557);
    let end = -1;
    for (let i = zip.length - 22; i >= searchFrom; i--)
      if (zip.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    if (end < 0) bad();
    const count = zip.readUInt16LE(end + 10);
    const size = zip.readUInt32LE(end + 12);
    let at = zip.readUInt32LE(end + 16);
    if (count > limits.maxEntries || count === 0xffff || at === 0xffffffff || at + size > end)
      bad();
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) bad();
      const nameLength = zip.readUInt16LE(at + 28);
      const entry: Entry = {
        flags: zip.readUInt16LE(at + 8),
        method: zip.readUInt16LE(at + 10),
        compressed: zip.readUInt32LE(at + 20),
        uncompressed: zip.readUInt32LE(at + 24),
        local: zip.readUInt32LE(at + 42),
      };
      total += entry.uncompressed;
      if (total > limits.maxTotal || entry.uncompressed === 0xffffffff) bad();
      this.entries.set(zip.toString("utf8", at + 46, at + 46 + nameLength), entry);
      at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    }
  }

  has(name: string) {
    return this.entries.has(name);
  }

  /** Entry bytes, or `zip_invalid` for anything malformed, encrypted or oversized. */
  read(name: string): Buffer {
    const entry = this.entries.get(name) ?? bad();
    const { zip, limits } = this;
    if (entry.flags & 1 || (entry.method !== 0 && entry.method !== 8)) bad();
    if (entry.uncompressed > limits.maxEntry) bad();
    if (
      entry.uncompressed > 1024 * 1024 &&
      entry.uncompressed / Math.max(1, entry.compressed) > limits.maxRatio
    )
      bad();
    const local = entry.local;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) bad();
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + entry.compressed > zip.length) bad();
    const data = zip.subarray(start, start + entry.compressed);
    let out: Buffer;
    try {
      // The declared size is not trusted: the inflate is capped at it.
      out =
        entry.method === 0
          ? Buffer.from(data)
          : inflateRawSync(data, { maxOutputLength: Math.max(1, entry.uncompressed) });
    } catch {
      return bad();
    }
    if (out.length !== entry.uncompressed) bad();
    return out;
  }

  /** UTF-8 XML of an entry; a DTD (never used by Office files) is rejected, so no entity expansion. */
  xml(name: string): string {
    const text = this.read(name).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) bad();
    return text;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The five XML entities and numeric references only. */
export const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });

/** `Target` of every relationship in a `.rels` part, by `Id`, with its `Type`. */
export function relationships(xml: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1] as string);
    if (attrs.Id && attrs.Target && attrs.TargetMode !== "External")
      out.set(attrs.Id, { target: attrs.Target, type: attrs.Type ?? "" });
  }
  return out;
}

export function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
    out[m[1] as string] = decodeXml(m[3] ?? m[4] ?? "");
  return out;
}

/** Resolves a relationship target against the folder of its source part; never leaves the zip root. */
export function resolvePart(baseFolder: string, target: string): string {
  const parts = target.startsWith("/") ? [] : baseFolder.split("/").filter(Boolean);
  for (const piece of target.replace(/^\//, "").split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (parts.length === 0) bad();
      parts.pop();
    } else parts.push(piece);
  }
  return parts.join("/");
}
