import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, canonicalLine } from "./storage.js";
import { type ClaimRecord, claimKinds, idPatterns } from "./types.js";

/** Claims live in `claims/claims.jsonl`, one canonical JSON line each (spec 4.3 and 8.5). */
export const claimsPath = "claims/claims.jsonl";
export const anchorPattern = /^[A-Za-z0-9_-]{1,40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const knownKeys = new Set([
  "id",
  "section",
  "anchor",
  "text",
  "kind",
  "evidence",
  "results",
  "objectives",
]);

/** Schema problems of one claim line, as readable messages. */
export function validateClaimRecord(value: unknown): string[] {
  if (!isRecord(value)) return ["claim must be a JSON object"];
  const errors: string[] = [];
  for (const key of Object.keys(value))
    if (!knownKeys.has(key)) errors.push(`unknown field ${key}`);
  if (typeof value.id !== "string" || !idPatterns.claim.test(value.id))
    errors.push("id must look like CLM-0048");
  if (typeof value.section !== "string" || !idPatterns.section.test(value.section))
    errors.push("section must be a SEC id");
  if (typeof value.anchor !== "string" || !anchorPattern.test(value.anchor))
    errors.push("anchor is not a valid claim anchor");
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 400)
    errors.push("text must be 1 to 400 characters");
  if (!(claimKinds as readonly unknown[]).includes(value.kind)) errors.push("kind is not known");
  if (!stringList(value.evidence) || !value.evidence.every((id) => idPatterns.evidence.test(id)))
    errors.push("evidence must be a list of EVD ids");
  if (
    value.results !== undefined &&
    (!stringList(value.results) || !value.results.every((id) => idPatterns.claim.test(id)))
  )
    errors.push("results must be a list of CLM ids");
  if (
    !stringList(value.objectives) ||
    !value.objectives.every((id) => idPatterns.objective.test(id))
  )
    errors.push("objectives must be a list of OBJ ids");
  return errors;
}

export interface ClaimsParse {
  records: ClaimRecord[];
  errors: { line: number; message: string }[];
}

export function parseClaimsText(text: string | undefined): ClaimsParse {
  const result: ClaimsParse = { records: [], errors: [] };
  if (!text) return result;
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      result.errors.push({ line: index + 1, message: "line is not valid JSON" });
      return;
    }
    const problems = validateClaimRecord(value);
    if (problems.length > 0) {
      for (const message of problems) result.errors.push({ line: index + 1, message });
      return;
    }
    result.records.push(value as ClaimRecord);
  });
  return result;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function serializeClaims(records: readonly ClaimRecord[]): string {
  const lines = [...records].sort(byId).map((record) => canonicalLine(record));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export const claimId = (counter: number): string => `CLM-${String(counter).padStart(4, "0")}`;

export async function readClaims(base: string): Promise<ClaimRecord[]> {
  let text: string;
  try {
    text = await readFile(join(base, claimsPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseClaimsText(text);
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(
      `claims/claims.jsonl is invalid (line ${first?.line}: ${first?.message}); run /thesis:check`,
    );
  }
  return parsed.records;
}

export async function writeClaims(base: string, records: readonly ClaimRecord[]): Promise<void> {
  await atomicWrite(join(base, claimsPath), serializeClaims(records));
}
