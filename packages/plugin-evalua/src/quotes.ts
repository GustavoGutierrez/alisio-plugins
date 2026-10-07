import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { CheckCollector, type CheckReport } from "./knowledge/report.js";
import { isRecord } from "./schemas.js";

export type QuoteKind = "quote" | "bible";

export interface QuoteEntry {
  id: string;
  kind: QuoteKind;
  text: string;
  author?: string;
  reference?: string;
  source: string;
  translation?: string;
  tags: string[];
  language: string;
}

const MIN_TEXT = 20;
const MAX_TEXT = 400;
const MAX_FILE_BYTES = 256 * 1024;

function readEntry(
  value: unknown,
  kind: QuoteKind,
  subject: string,
  collector: CheckCollector,
): QuoteEntry | undefined {
  if (!isRecord(value)) {
    collector.error("EVL-DOC-003", subject, "quote entry must be a mapping");
    return undefined;
  }
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (id === undefined) collector.error("EVL-DOC-003", subject, "quote entry needs an id");
  if (text.length < MIN_TEXT || text.length > MAX_TEXT) {
    collector.error(
      "EVL-DOC-003",
      subject,
      `quote text must be ${MIN_TEXT}..${MAX_TEXT} characters`,
    );
  }
  if (source === "") collector.error("EVL-DOC-003", subject, "quote entry needs a source");
  if (id === undefined || text.length < MIN_TEXT || text.length > MAX_TEXT || source === "") {
    return undefined;
  }
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id,
    kind,
    text,
    ...(typeof value.author === "string" ? { author: value.author } : {}),
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
    source,
    ...(typeof value.translation === "string" ? { translation: value.translation } : {}),
    tags,
    language: typeof value.language === "string" ? value.language : "es",
  };
}

export function parseQuoteFile(
  text: string,
  kind: QuoteKind,
  subject: string,
  collector: CheckCollector,
): QuoteEntry[] {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    collector.error("EVL-DOC-003", subject, "quote file exceeds the size limit");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    collector.error(
      "EVL-DOC-003",
      subject,
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    collector.error("EVL-DOC-003", subject, "quote file must contain a list");
    return [];
  }
  const entries: QuoteEntry[] = [];
  const seen = new Set<string>();
  parsed.forEach((value, index) => {
    const entry = readEntry(value, kind, `${subject} entry ${index + 1}`, collector);
    if (entry === undefined) return;
    if (seen.has(entry.id)) {
      collector.error("EVL-DOC-003", subject, `duplicate quote id "${entry.id}"`);
      return;
    }
    seen.add(entry.id);
    entries.push(entry);
  });
  return entries;
}

export interface QuotesCatalogue {
  entries: QuoteEntry[];
  report: CheckReport;
}

export interface QuotesLayer {
  dir: string;
  layer: "shipped" | "workspace";
}

/**
 * Loads quote layers in precedence order (shipped first, workspace last). A later entry with the
 * same id replaces an earlier one, so a teacher's workspace quotes override the shipped catalogue.
 */
export async function loadQuotesLayers(layers: readonly QuotesLayer[]): Promise<QuotesCatalogue> {
  const collector = new CheckCollector();
  const byId = new Map<string, QuoteEntry>();
  const order: string[] = [];
  for (const layer of layers) {
    const catalogue = await loadQuotes(layer.dir);
    for (const finding of catalogue.report.results) collector.results.push(finding);
    for (const entry of catalogue.entries) {
      if (!byId.has(entry.id)) order.push(entry.id);
      byId.set(entry.id, entry);
    }
  }
  const entries = order
    .map((id) => byId.get(id))
    .filter((entry): entry is QuoteEntry => entry !== undefined);
  return { entries, report: collector.report() };
}

/** Loads `quotes.yaml` and `bible-rvr1909.yaml` from a quotes directory. */
export async function loadQuotes(dir: string): Promise<QuotesCatalogue> {
  const collector = new CheckCollector();
  const entries: QuoteEntry[] = [];
  const files: Array<{ name: string; kind: QuoteKind }> = [
    { name: "quotes.yaml", kind: "quote" },
    { name: "bible-rvr1909.yaml", kind: "bible" },
  ];
  for (const file of files) {
    try {
      const text = await readFile(join(dir, file.name), "utf8");
      entries.push(...parseQuoteFile(text, file.kind, file.name, collector));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { entries, report: collector.report() };
}

export interface ClosingSelection {
  entry?: QuoteEntry;
  teacherText?: string;
}

export interface ClosingInput {
  kind: "none" | "quote" | "bible";
  pinned?: string | null;
  teacherText?: string | null;
  language: string;
  keywords: readonly string[];
  examId: string;
  entries: readonly QuoteEntry[];
}

function tieBreak(examId: string, id: string): string {
  return createHash("sha256").update(`${examId}\u0000${id}`).digest("hex");
}

/** Deterministic closing selection: teacher text wins, then a pinned id, then tag-overlap scoring. */
export function selectClosing(input: ClosingInput): ClosingSelection {
  if (input.kind === "none") return {};
  if (input.teacherText !== undefined && input.teacherText !== null && input.teacherText !== "") {
    return { teacherText: input.teacherText };
  }
  if (input.pinned !== undefined && input.pinned !== null && input.pinned !== "") {
    const pinned = input.entries.find((entry) => entry.id === input.pinned);
    return pinned === undefined ? { teacherText: input.pinned } : { entry: pinned };
  }
  const keywords = new Set(input.keywords.map((keyword) => keyword.toLowerCase()));
  const candidates = input.entries.filter(
    (entry) => entry.kind === input.kind && entry.language === input.language,
  );
  const ranked = candidates
    .map((entry) => ({
      entry,
      score: entry.tags.reduce((acc, tag) => acc + (keywords.has(tag.toLowerCase()) ? 1 : 0), 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        tieBreak(input.examId, a.entry.id).localeCompare(tieBreak(input.examId, b.entry.id)),
    );
  const best = ranked[0];
  return best === undefined ? {} : { entry: best.entry };
}
