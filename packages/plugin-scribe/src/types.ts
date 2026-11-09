export type Locale = "es" | "en";
export interface Asset {
  id: string;
  name: string;
  path: string;
  mime: string;
  base64: string;
}
export interface Revision {
  id: string;
  tex: string;
  bib: string;
  summary: string;
  at: string;
}
export interface Proposal {
  id: string;
  baseRevision: string;
  tex: string;
  bib: string;
  summary: string;
}
export interface Document {
  id: string;
  title: string;
  discipline: string;
  language: Locale;
  model: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  brief: string;
  revisions: Revision[];
  assets: Asset[];
  proposals: Proposal[];
  pdf?: { revision: string; assetFingerprint: string; filename: string; at: string };
}
export interface Job {
  id: string;
  documentId: string;
  action: "draft" | "compile";
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  message: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  baseRevision: string;
  usage?: { input: number; output: number };
}

/**
 * Document limits shared by every write path and by project import, so any document Scribe stores
 * (and therefore exports) can be imported again.
 */
export const LIMITS = {
  /** Largest single attachment, decoded. */
  assetBytes: 25 * 1024 * 1024,
  /** Largest sum of all attachments of one document, decoded. */
  totalAssetBytes: 100 * 1024 * 1024,
  /** Attachments per document. */
  assets: 200,
  /** Revisions kept per document; older revisions are pruned when a new one is added. */
  revisions: 200,
  tex: 400_000,
  bib: 100_000,
  summary: 2000,
  title: 160,
} as const;

export class ScribeError extends Error {
  constructor(
    public code: string,
    message = code,
    public status = 400,
  ) {
    super(message);
  }
}
export function string(value: unknown, max = 24000): string {
  if (typeof value !== "string" || value.length > max) throw new ScribeError("invalid_input");
  return value;
}
export function identifier(value: unknown): string {
  const id = string(value, 80);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ScribeError("invalid_id");
  return id;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  csv: "text/csv",
  json: "application/json",
  bib: "text/plain",
  txt: "text/plain",
};
const ASSET_NAME = /^[a-zA-Z0-9_. -]+\.(png|jpe?g|pdf|csv|json|bib|txt)$/i;

/**
 * Validate an attachment name and base64 payload. Returns the decoded size, extension and MIME
 * type. Size budgets across the document are the caller's responsibility (see `checkAssetBudget`).
 */
export function validateAsset(
  nameValue: unknown,
  base64Value: unknown,
): { name: string; base64: string; ext: string; mime: string; bytes: number } {
  const name = string(nameValue, 120);
  const match = ASSET_NAME.exec(name);
  if (!match?.[1]) throw new ScribeError("asset_type");
  // Base64 of the largest asset, rounded up, so oversize payloads fail before decoding.
  const base64 = string(base64Value, Math.ceil(LIMITS.assetBytes / 3) * 4 + 4);
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) throw new ScribeError("invalid_input");
  const data = Buffer.from(base64, "base64");
  if (data.length > LIMITS.assetBytes) throw new ScribeError("asset_limit");
  const ext = match[1].toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new ScribeError("asset_type");
  if (ext === "png" && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new ScribeError("asset_type");
  if ((ext === "jpg" || ext === "jpeg") && !(data[0] === 255 && data[1] === 216 && data[2] === 255))
    throw new ScribeError("asset_type");
  if (ext === "pdf" && data.subarray(0, 5).toString() !== "%PDF-")
    throw new ScribeError("asset_type");
  if (["csv", "json", "bib", "txt"].includes(ext) && data.includes(0))
    throw new ScribeError("asset_type");
  if (ext === "json") {
    try {
      JSON.parse(data.toString("utf8"));
    } catch {
      throw new ScribeError("asset_type");
    }
  }
  return { name, base64, ext, mime, bytes: data.length };
}

/** Throw `asset_limit` when a document would exceed the attachment count or total size. */
export function checkAssetBudget(count: number, totalBytes: number): void {
  if (count > LIMITS.assets || totalBytes > LIMITS.totalAssetBytes)
    throw new ScribeError("asset_limit");
}

/** Append a revision, keeping only the newest `LIMITS.revisions` so the document stays importable. */
export function pushRevision(document: Document, revision: Revision): void {
  document.revisions.push(revision);
  if (document.revisions.length > LIMITS.revisions)
    document.revisions.splice(0, document.revisions.length - LIMITS.revisions);
}
