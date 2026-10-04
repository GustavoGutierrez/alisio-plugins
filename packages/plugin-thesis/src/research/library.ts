import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, canonicalLine } from "../storage.js";
import {
  citableStatuses,
  type EvidenceRecord,
  type EvidenceStatus,
  evidenceStatuses,
  evidenceTypes,
  idPatterns,
  permittedUses,
  type SectionId,
} from "../types.js";
import { fold, foldFamily, type RecordDraft, titleKey } from "./verify.js";

/** Paths relative to the thesis root. */
export const evidencePaths = {
  library: "evidence/library.jsonl",
  rejected: "evidence/rejected.jsonl",
  searchLog: "evidence/search-log.jsonl",
  bibliography: "bibliography/references.bib",
  dossiers: "evidence/dossiers",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown): boolean =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const knownKeys = new Set([
  "id",
  "citeKey",
  "type",
  "title",
  "authors",
  "year",
  "containerTitle",
  "volume",
  "issue",
  "pages",
  "publisher",
  "placeOfPublication",
  "doi",
  "isbn",
  "issn",
  "url",
  "language",
  "retrievedAt",
  "verification",
  "status",
  "appraisal",
  "permittedUse",
  "sections",
]);
const optionalStrings = [
  "containerTitle",
  "volume",
  "issue",
  "pages",
  "publisher",
  "placeOfPublication",
  "doi",
  "isbn",
  "issn",
  "url",
  "language",
];

/** Schema validation of one library line (check EVD-001). Returns human-readable problems. */
export function validateEvidenceRecord(value: unknown): string[] {
  if (!isRecord(value)) return ["record must be a JSON object"];
  const errors: string[] = [];
  for (const key of Object.keys(value))
    if (!knownKeys.has(key)) errors.push(`unknown field ${key}`);
  if (typeof value.id !== "string" || !idPatterns.evidence.test(value.id))
    errors.push("id must look like EVD-00231");
  if (typeof value.citeKey !== "string" || !idPatterns.citationKey.test(value.citeKey))
    errors.push("citeKey is not a valid citation key");
  if (!(evidenceTypes as readonly unknown[]).includes(value.type))
    errors.push("type is not a known evidence type");
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 600)
    errors.push("title must be 1 to 600 characters");
  if (
    !Array.isArray(value.authors) ||
    !value.authors.every(
      (author) => isRecord(author) && typeof author.family === "string" && author.family.trim(),
    )
  ) {
    errors.push("authors must be a list of { family }");
  }
  if (
    !Number.isInteger(value.year) ||
    (value.year as number) < 1000 ||
    (value.year as number) > 2200
  )
    errors.push("year must be an integer");
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      errors.push(`${key} must be a string`);
  }
  if (!isIso(value.retrievedAt)) errors.push("retrievedAt must be an ISO date");
  const verification = value.verification;
  if (
    !isRecord(verification) ||
    !["crossref", "openalex", "arxiv", "official_domain", "user_supplied"].includes(
      verification.method as string,
    ) ||
    typeof verification.metadataMatch !== "number" ||
    verification.metadataMatch < 0 ||
    verification.metadataMatch > 1 ||
    typeof verification.retracted !== "boolean" ||
    !isIso(verification.checkedAt)
  ) {
    errors.push("verification is malformed");
  }
  if (!(evidenceStatuses as readonly unknown[]).includes(value.status))
    errors.push("status is not a known status");
  const appraisal = value.appraisal;
  if (
    !isRecord(appraisal) ||
    !["high", "medium", "low"].includes(appraisal.relevance as string) ||
    typeof appraisal.evidenceType !== "string" ||
    !Array.isArray(appraisal.limitations) ||
    !Array.isArray(appraisal.supports)
  ) {
    errors.push("appraisal is malformed");
  }
  if (
    !Array.isArray(value.permittedUse) ||
    !value.permittedUse.every((use) => (permittedUses as readonly unknown[]).includes(use))
  ) {
    errors.push("permittedUse is malformed");
  }
  if (
    !Array.isArray(value.sections) ||
    !value.sections.every(
      (section) => typeof section === "string" && idPatterns.section.test(section),
    )
  ) {
    errors.push("sections must be a list of SEC ids");
  }
  return errors;
}

export interface LibraryParse {
  records: EvidenceRecord[];
  errors: { line: number; message: string }[];
}

export function parseLibraryText(text: string | undefined): LibraryParse {
  const result: LibraryParse = { records: [], errors: [] };
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
    const problems = validateEvidenceRecord(value);
    if (problems.length > 0) {
      for (const message of problems) result.errors.push({ line: index + 1, message });
      return;
    }
    result.records.push(value as EvidenceRecord);
  });
  return result;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readLibrary(base: string): Promise<EvidenceRecord[]> {
  const parsed = parseLibraryText(await readText(join(base, evidencePaths.library)));
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(
      `evidence/library.jsonl is invalid (line ${first?.line}: ${first?.message}); run /thesis:check`,
    );
  }
  return parsed.records;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function serializeLibrary(records: readonly EvidenceRecord[]): string {
  const lines = [...records].sort(byId).map((record) => canonicalLine(record));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export async function writeLibrary(
  base: string,
  records: readonly EvidenceRecord[],
): Promise<void> {
  await atomicWrite(join(base, evidencePaths.library), serializeLibrary(records));
}

// ---------------------------------------------------------------------------------------------
// Ids and citation keys
// ---------------------------------------------------------------------------------------------

export const evidenceId = (counter: number): string => `EVD-${String(counter).padStart(5, "0")}`;

/** Next id counter: never below the state counter or the highest id already in the library. */
export function nextEvidenceCounter(
  stateCounter: number,
  records: readonly EvidenceRecord[],
): number {
  const highest = records.reduce((max, record) => Math.max(max, Number(record.id.slice(4))), 0);
  return Math.max(stateCounter, highest) + 1;
}

const stopForKey = new Set([
  "the",
  "a",
  "an",
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "un",
  "una",
  "of",
  "on",
  "for",
]);

/** `[a-z][a-z0-9]{1,30}\d{4}[a-z]?`: author family (or a title word), year, then a disambiguator. */
export function allocateCiteKey(
  draft: Pick<RecordDraft, "authors" | "title" | "year">,
  taken: ReadonlySet<string>,
): string {
  const first = draft.authors[0]?.family;
  let stem = first ? foldFamily(first) : "";
  if (!stem) {
    stem =
      fold(draft.title)
        .split(/[^a-z0-9]+/)
        .filter((word) => word && !stopForKey.has(word))[0] ?? "";
  }
  stem = stem.replace(/^[^a-z]+/, "").slice(0, 24);
  if (stem.length < 2) stem = "anon";
  const base = `${stem}${draft.year}`;
  if (!taken.has(base)) return base;
  for (const letter of "bcdefghijklmnopqrstuvwxyz") {
    const candidate = `${base}${letter}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Too many records share the citation key base ${base}`);
}

// ---------------------------------------------------------------------------------------------
// Adding and merging
// ---------------------------------------------------------------------------------------------

export interface AppraisalInput {
  relevance: "high" | "medium" | "low";
  evidenceType: string;
  limitations: string[];
  supports: string[];
  location?: string | undefined;
  permittedUse: EvidenceRecord["permittedUse"];
}

const relevanceRank = { high: 0, medium: 1, low: 2 } as const;

function findDuplicate(
  records: readonly EvidenceRecord[],
  draft: RecordDraft,
): EvidenceRecord | undefined {
  const doi = draft.doi?.toLowerCase();
  const key = titleKey(draft.title);
  return [...records]
    .sort(byId)
    .find(
      (record) =>
        (doi !== undefined && record.doi?.toLowerCase() === doi) ||
        (record.year === draft.year && titleKey(record.title) === key),
    );
}

export interface AddResult {
  record: EvidenceRecord;
  merged: boolean;
}

/**
 * Add a verified draft to the in-memory library, or merge it into the oldest duplicate. The
 * `counter` object is advanced when a new id is allocated.
 */
export function addOrMerge(
  records: EvidenceRecord[],
  draft: RecordDraft,
  appraisal: AppraisalInput,
  sectionId: SectionId,
  counter: { value: number },
  status: EvidenceStatus = draft.status,
): AddResult {
  const existing = findDuplicate(records, draft);
  if (existing) {
    const sections = new Set([...existing.sections, sectionId]);
    existing.sections = [...sections].sort();
    existing.appraisal = {
      ...existing.appraisal,
      relevance:
        relevanceRank[appraisal.relevance] < relevanceRank[existing.appraisal.relevance]
          ? appraisal.relevance
          : existing.appraisal.relevance,
      limitations: [...new Set([...existing.appraisal.limitations, ...appraisal.limitations])],
      supports: [...new Set([...existing.appraisal.supports, ...appraisal.supports])],
    };
    existing.permittedUse = permittedUses.filter(
      (use) => existing.permittedUse.includes(use) || appraisal.permittedUse.includes(use),
    );
    return { record: existing, merged: true };
  }
  const taken = new Set(records.map((record) => record.citeKey));
  const record: EvidenceRecord = {
    id: evidenceId(counter.value),
    citeKey: allocateCiteKey(draft, taken),
    type: draft.type,
    title: draft.title,
    authors: draft.authors,
    year: draft.year,
    ...(draft.containerTitle ? { containerTitle: draft.containerTitle } : {}),
    ...(draft.volume ? { volume: draft.volume } : {}),
    ...(draft.issue ? { issue: draft.issue } : {}),
    ...(draft.pages ? { pages: draft.pages } : {}),
    ...(draft.publisher ? { publisher: draft.publisher } : {}),
    ...(draft.placeOfPublication ? { placeOfPublication: draft.placeOfPublication } : {}),
    ...(draft.doi ? { doi: draft.doi } : {}),
    ...(draft.isbn ? { isbn: draft.isbn } : {}),
    ...(draft.issn ? { issn: draft.issn } : {}),
    ...(draft.url ? { url: draft.url } : {}),
    ...(draft.language ? { language: draft.language } : {}),
    retrievedAt: draft.verification.checkedAt.slice(0, 10),
    verification: draft.verification,
    status,
    appraisal: {
      relevance: appraisal.relevance,
      evidenceType: appraisal.evidenceType,
      limitations: appraisal.limitations,
      supports: appraisal.supports,
      ...(appraisal.location ? { location: appraisal.location } : {}),
    },
    permittedUse: appraisal.permittedUse,
    sections: [sectionId],
  };
  counter.value += 1;
  records.push(record);
  return { record, merged: false };
}

export const isCitable = (record: Pick<EvidenceRecord, "status">): boolean =>
  citableStatuses.includes(record.status);

/** Citable for a section: a citable status, or CONTEXTUAL_ONLY with the user's explicit approval. */
export function citableForSection(
  record: EvidenceRecord,
  contextualApprovals: readonly string[] | undefined,
): boolean {
  return (
    isCitable(record) ||
    (record.status === "CONTEXTUAL_ONLY" && (contextualApprovals ?? []).includes(record.id))
  );
}

// ---------------------------------------------------------------------------------------------
// Rejected candidates and the search log (append-only JSONL, written atomically)
// ---------------------------------------------------------------------------------------------

export interface RejectedEntry {
  at: string;
  sectionId: SectionId;
  identifier: string;
  title?: string;
  status: "UNVERIFIED" | "REJECTED";
  reason: string;
  detail?: string;
}

export interface SearchLogEntry {
  at: string;
  sectionId: SectionId;
  source: string;
  query: string;
  filters: { fromYear?: number; toYear?: number; language?: string; limit: number };
  hits: number;
  selected: string[];
  error?: string;
}

async function appendLines(path: string, entries: readonly unknown[]): Promise<void> {
  if (entries.length === 0) return;
  const current = (await readText(path)) ?? "";
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  await atomicWrite(path, `${prefix}${entries.map((entry) => canonicalLine(entry)).join("\n")}\n`);
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readText(path);
  if (!text) return [];
  const values: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // A damaged log line never blocks a research run.
    }
  }
  return values;
}

export async function appendSearchLog(
  base: string,
  entries: readonly SearchLogEntry[],
): Promise<void> {
  await appendLines(join(base, evidencePaths.searchLog), entries);
}

export async function readSearchLog(base: string): Promise<SearchLogEntry[]> {
  return readJsonl<SearchLogEntry>(join(base, evidencePaths.searchLog));
}

export async function appendRejected(
  base: string,
  entries: readonly RejectedEntry[],
): Promise<void> {
  const known = new Set(
    (await readJsonl<RejectedEntry>(join(base, evidencePaths.rejected))).map(
      (entry) => `${entry.sectionId}|${entry.identifier}|${entry.reason}`,
    ),
  );
  const fresh = entries.filter(
    (entry) => !known.has(`${entry.sectionId}|${entry.identifier}|${entry.reason}`),
  );
  await appendLines(join(base, evidencePaths.rejected), fresh);
}
