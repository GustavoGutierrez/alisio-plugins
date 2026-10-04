import { join } from "node:path";
import { stripControl } from "../schemas.js";
import { atomicWrite } from "../storage.js";
import type { EvidenceRecord, EvidenceType } from "../types.js";
import { evidencePaths } from "./library.js";

/** Characters that carry meaning inside a BibTeX field value. */
export function escapeBibtex(value: string): string {
  return stripControl(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\{}&%$#_^~]/g, (char) => {
      switch (char) {
        case "\\":
          return "\\textbackslash{}";
        case "^":
          return "\\^{}";
        case "~":
          return "\\~{}";
        default:
          return `\\${char}`;
      }
    });
}

const entryTypes: Record<EvidenceType, string> = {
  journal_article: "article",
  book: "book",
  chapter: "inbook",
  conference_paper: "inproceedings",
  thesis: "thesis",
  report: "techreport",
  standard: "misc",
  law: "misc",
  dataset: "misc",
  web_page: "online",
  preprint: "misc",
};

export type TypeLabels = Partial<Record<EvidenceType, string>>;

/** English labels printed by styles for types that have no entry type of their own. */
export const defaultTypeLabels: TypeLabels = {
  law: "Law",
  standard: "Standard",
  dataset: "Dataset",
  preprint: "Preprint",
  thesis: "Thesis",
};

const accessedTypes = new Set<EvidenceType>(["web_page", "law", "standard", "dataset"]);

function author(entry: EvidenceRecord["authors"][number]): string {
  const family = escapeBibtex(entry.family);
  const given = entry.given ? escapeBibtex(entry.given) : "";
  // A name without a given part is an organization: protect it from being split.
  return given ? `${family}, ${given}` : `{${family}}`;
}

/** One entry. Field order is fixed so the output is byte-stable. */
export function bibtexEntry(
  record: EvidenceRecord,
  labels: TypeLabels = defaultTypeLabels,
): string {
  const fields: [string, string][] = [];
  const add = (name: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    fields.push([name, String(value)]);
  };
  if (record.authors.length > 0) add("author", record.authors.map(author).join(" and "));
  // Double braces keep the capitalization of the title as written.
  add("title", `{${escapeBibtex(record.title)}}`);
  add("year", record.year);
  const container = record.containerTitle ? escapeBibtex(record.containerTitle) : undefined;
  if (record.type === "journal_article") add("journal", container);
  else if (record.type === "chapter" || record.type === "conference_paper")
    add("booktitle", container);
  else add("howpublished", container);
  add("volume", record.volume ? escapeBibtex(record.volume) : undefined);
  add("number", record.issue ? escapeBibtex(record.issue) : undefined);
  add(
    "pages",
    record.pages ? escapeBibtex(record.pages).replace(/(?<=\d)-(?=\d)/g, "--") : undefined,
  );
  add("publisher", record.publisher ? escapeBibtex(record.publisher) : undefined);
  add("address", record.placeOfPublication ? escapeBibtex(record.placeOfPublication) : undefined);
  add("isbn", record.isbn ? escapeBibtex(record.isbn) : undefined);
  add("issn", record.issn ? escapeBibtex(record.issn) : undefined);
  add("doi", record.doi ? escapeBibtex(record.doi).replace(/\\_/g, "_") : undefined);
  add(
    "url",
    record.url ? record.url.replace(/[{}\\\s]/g, (char) => encodeURIComponent(char)) : undefined,
  );
  // The access date of online sources comes from the verification time (styles print it).
  if (
    record.url &&
    accessedTypes.has(record.type) &&
    /^\d{4}-\d{2}-\d{2}/.test(record.retrievedAt)
  ) {
    add("urldate", record.retrievedAt.slice(0, 10));
  }
  add("language", record.language ? escapeBibtex(record.language) : undefined);
  add("type", labels[record.type] ? escapeBibtex(labels[record.type] as string) : undefined);
  const body = fields.map(([name, value]) => `  ${name} = {${value}},`).join("\n");
  return `@${entryTypes[record.type]}{${record.citeKey},\n${body}\n}\n`;
}

/** Deterministic `references.bib` content for a library: sorted by citation key, LF, no timestamps. */
export function generateBibtex(
  records: readonly EvidenceRecord[],
  labels: TypeLabels = defaultTypeLabels,
): string {
  const sorted = [...records].sort((a, b) =>
    a.citeKey < b.citeKey ? -1 : a.citeKey > b.citeKey ? 1 : 0,
  );
  return sorted.map((record) => bibtexEntry(record, labels)).join("\n");
}

export async function writeBibtex(base: string, records: readonly EvidenceRecord[]): Promise<void> {
  await atomicWrite(join(base, evidencePaths.bibliography), generateBibtex(records));
}
