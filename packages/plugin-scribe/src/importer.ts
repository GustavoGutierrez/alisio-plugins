import { randomUUID } from "node:crypto";
import {
  type Asset,
  checkAssetBudget,
  type Document,
  identifier,
  LIMITS,
  ScribeError,
  string,
  validateAsset,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScribeError("invalid_input");
  return value as Record<string, unknown>;
}

/**
 * Import our JSON export into a new identity. Never trust stored paths, jobs or PDFs.
 * Uses the same `LIMITS` as every write path, so any exported document can be imported again.
 */
export function importProject(value: unknown): Document {
  const envelope = record(value);
  if (envelope.schemaVersion !== 1) throw new ScribeError("invalid_input");
  const input = record(envelope.document);
  if (
    !Array.isArray(input.revisions) ||
    !input.revisions.length ||
    input.revisions.length > LIMITS.revisions ||
    !Array.isArray(input.assets) ||
    input.assets.length > LIMITS.assets
  )
    throw new ScribeError("invalid_input");
  let total = 0;
  const seen = new Set<string>();
  const assets: Asset[] = input.assets.map((item: unknown) => {
    const raw = record(item);
    const id = identifier(raw.id);
    if (seen.has(id)) throw new ScribeError("invalid_input");
    seen.add(id);
    const asset = validateAsset(raw.name, raw.base64);
    total += asset.bytes;
    checkAssetBudget(seen.size, total);
    const path = `assets/${id}.${asset.ext}`;
    if (raw.path !== path) throw new ScribeError("invalid_input");
    return { id, name: asset.name, path, mime: asset.mime, base64: asset.base64 };
  });
  const title = string(input.title, LIMITS.title).trim();
  if (!title) throw new ScribeError("invalid_input");
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    title,
    brief: string(input.brief ?? ""),
    discipline: string(input.discipline ?? "physics", 40),
    language: input.language === "es" ? "es" : "en",
    model: "",
    archived: false,
    createdAt: at,
    updatedAt: at,
    assets,
    proposals: [],
    revisions: input.revisions.map((item: unknown) => {
      const r = record(item);
      return {
        id: randomUUID(),
        tex: string(r.tex, LIMITS.tex),
        bib: string(r.bib ?? "", LIMITS.bib),
        summary: string(r.summary ?? "Imported", LIMITS.summary),
        at,
      };
    }),
  };
}
