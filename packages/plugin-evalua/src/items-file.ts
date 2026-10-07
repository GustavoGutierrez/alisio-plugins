import { createHash } from "node:crypto";
import type { ExamItem } from "./generate.js";
import { isRecord } from "./schemas.js";
import { canonicalJson } from "./storage.js";

/** Freezing and reading `items.json` (spec 5.3, 5.5): the frozen exam never regenerates. */

export interface ItemsFile {
  schemaVersion: 1;
  items: ExamItem[];
}

export function freezeItems(items: readonly ExamItem[]): string {
  return canonicalJson({ schemaVersion: 1, items: [...items] } satisfies ItemsFile);
}

function looksLikeItem(value: unknown): value is ExamItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.ref === "string" &&
    typeof value.type === "string" &&
    Array.isArray(value.stem) &&
    isRecord(value.answer)
  );
}

/** Tolerant reader: keeps well-formed items and drops unknown fields. */
export function parseItemsFile(text: string): ExamItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("items.json is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) {
    throw new Error("items.json must be a schemaVersion 1 object with an items list");
  }
  return parsed.items.filter(looksLikeItem);
}

export function itemsSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
