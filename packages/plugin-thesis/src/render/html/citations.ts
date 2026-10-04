import type { EvidenceRecord } from "../../types.js";
import type { CitationItem, I18nStrings } from "../model.js";
import { escapeHtml } from "./escape.js";

/**
 * Built-in citation formatter for the HTML/Chrome output (spec 10.7). citeproc-js is CPAL/AGPL and
 * not allowed on the main path, so this module renders the *basic shapes* of the shipped style
 * families: author-date (APA-like), numeric (IEEE-like) and note (ICONTEC-like). It approximates
 * the CSL output of the selected style and never replaces it: the Typst engine formats citations
 * from the real CSL file. Workspace styles map onto the family of their `citation-format`.
 */

export type CitationFamily = "author-date" | "numeric" | "note";

export const citationFamily = (format: string): CitationFamily =>
  format === "numeric" || format === "label"
    ? "numeric"
    : format === "note"
      ? "note"
      : "author-date";

interface Words {
  and: string;
  etAl: string;
  vol: string;
  no: string;
  pp: string;
  p: string;
  retrieved: string;
  inWord: string;
  edition: string;
  noDate: string;
}

const words: Record<string, Words> = {
  es: {
    and: "y",
    etAl: "et al.",
    vol: "vol.",
    no: "n.º",
    pp: "pp.",
    p: "p.",
    retrieved: "Consultado en",
    inWord: "En",
    edition: "ed.",
    noDate: "s. f.",
  },
  en: {
    and: "&",
    etAl: "et al.",
    vol: "vol.",
    no: "no.",
    pp: "pp.",
    p: "p.",
    retrieved: "Retrieved from",
    inWord: "In",
    edition: "ed.",
    noDate: "n.d.",
  },
  pt: {
    and: "e",
    etAl: "et al.",
    vol: "v.",
    no: "n.º",
    pp: "pp.",
    p: "p.",
    retrieved: "Disponível em",
    inWord: "Em",
    edition: "ed.",
    noDate: "s. d.",
  },
};

const em = (text: string) => `<em>${escapeHtml(text)}</em>`;

/** Initials from a given name: `Ana María` becomes `A. M.`. */
function initials(given: string | undefined): string {
  if (!given) return "";
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${(Array.from(part)[0] as string).toUpperCase()}.`)
    .join(" ");
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

export interface CitationOutput {
  /** In-text HTML, with each cited source linked to its bibliography entry. */
  html: string;
  /** Set for note styles: the HTML of the footnote the call becomes. */
  note?: boolean;
}

export interface BibliographyEntryHtml {
  key: string;
  /** Printed label for numeric styles, such as `[3]`. */
  label?: string;
  html: string;
}

export class CitationFormatter {
  readonly family: CitationFamily;
  private readonly w: Words;
  private readonly byKey: Map<string, EvidenceRecord>;
  /** Numeric styles: number by first citation, in document order. */
  private readonly numbers = new Map<string, number>();
  /** Note styles: keys already cited once, so later notes use the short form. */
  private readonly noted = new Set<string>();
  /** Keys in order of first citation, for the bibliography. */
  readonly cited: string[] = [];
  private suffixes: Map<string, string> | undefined;

  constructor(
    entries: readonly EvidenceRecord[],
    citationFormat: string,
    languageCode: string,
    private readonly strings: I18nStrings,
  ) {
    this.family = citationFamily(citationFormat);
    this.w = (words[languageCode] ?? words.en) as Words;
    this.byKey = new Map(entries.map((entry) => [entry.citeKey, entry]));
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  // -------------------------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------------------------

  private family1(record: EvidenceRecord): string | undefined {
    return record.authors[0]?.family;
  }

  /** Short author text for in-text author-date citations. */
  private inTextAuthors(record: EvidenceRecord): string {
    const names = record.authors.map((author) => author.family);
    if (names.length === 0) return this.shortTitle(record);
    if (names.length === 1) return names[0] as string;
    if (names.length === 2) return `${names[0]} ${this.w.and} ${names[1]}`;
    return `${names[0]} ${this.w.etAl}`;
  }

  private shortTitle(record: EvidenceRecord): string {
    const title = stripTrailingPeriod(record.title);
    const parts = title.split(/\s+/);
    return parts.length > 5 ? `${parts.slice(0, 5).join(" ")}…` : title;
  }

  /** `Family, A. B.` list in APA style (reference list). */
  private apaAuthors(record: EvidenceRecord): string {
    const list = record.authors.map((author) =>
      author.given ? `${author.family}, ${initials(author.given)}` : author.family,
    );
    if (list.length === 0) return "";
    if (list.length === 1) return list[0] as string;
    if (list.length <= 20)
      return `${list.slice(0, -1).join(", ")}${list.length > 2 ? "," : ""} ${this.w.and} ${list[list.length - 1]}`;
    return `${list.slice(0, 19).join(", ")}, … ${list[list.length - 1]}`;
  }

  /** `A. Family` list in IEEE style. */
  private ieeeAuthors(record: EvidenceRecord): string {
    const list = record.authors.map((author) =>
      author.given ? `${initials(author.given)} ${author.family}` : author.family,
    );
    if (list.length === 0) return "";
    if (list.length <= 2) return list.join(` ${this.w.and === "&" ? "and" : this.w.and} `);
    if (list.length > 6) return `${list[0]} ${this.w.etAl}`;
    return `${list.slice(0, -1).join(", ")}, ${this.w.and === "&" ? "and" : this.w.and} ${list[list.length - 1]}`;
  }

  /** `FAMILY, Given` list in ICONTEC style. */
  private icontecAuthors(record: EvidenceRecord): string {
    const list = record.authors.map((author) =>
      author.given
        ? `${author.family.toUpperCase()}, ${author.given}`
        : author.family.toUpperCase(),
    );
    if (list.length === 0) return "";
    if (list.length <= 3) return list.join("; ");
    return `${list[0]}; ${this.w.etAl}`;
  }

  // -------------------------------------------------------------------------------------------
  // In-text citations
  // -------------------------------------------------------------------------------------------

  private yearOf(record: EvidenceRecord): string {
    const suffix = this.disambiguation().get(record.citeKey) ?? "";
    return record.year ? `${record.year}${suffix}` : this.w.noDate;
  }

  /** Same first author and year get `a`, `b`, ... in the order of the reference list (APA). */
  private disambiguation(): Map<string, string> {
    if (this.suffixes) return this.suffixes;
    const groups = new Map<string, EvidenceRecord[]>();
    for (const record of this.byKey.values()) {
      const id = `${this.inTextAuthors(record).toLowerCase()}|${record.year}`;
      groups.set(id, [...(groups.get(id) ?? []), record]);
    }
    const suffixes = new Map<string, string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group
        .sort((a, b) => a.title.localeCompare(b.title))
        .forEach((record, index) => {
          suffixes.set(record.citeKey, String.fromCharCode(97 + (index % 26)));
        });
    }
    this.suffixes = suffixes;
    return suffixes;
  }

  private locatorText(item: CitationItem): string {
    return item.locator ? item.locator : "";
  }

  /** Register a cited key: numeric number and bibliography membership. */
  private register(key: string): number {
    if (!this.cited.includes(key)) this.cited.push(key);
    let number = this.numbers.get(key);
    if (number === undefined) {
      number = this.numbers.size + 1;
      this.numbers.set(key, number);
    }
    return number;
  }

  /**
   * Format one citation call. Unknown keys are the caller's problem (CIT-001); they are skipped here.
   */
  cite(items: readonly CitationItem[], narrative: boolean): CitationOutput {
    const known = items.filter((item) => this.byKey.has(item.key));
    for (const item of known) this.register(item.key);
    const link = (key: string, text: string) =>
      `<a class="cite-link" href="#ref-${escapeHtml(key)}">${escapeHtml(text)}</a>`;

    if (this.family === "note") {
      const notes = known.map((item) => this.note(item));
      return { html: notes.join("; "), note: true };
    }
    if (this.family === "numeric") {
      const parts = known.map((item) => {
        const number = this.numbers.get(item.key) as number;
        const locator = this.locatorText(item);
        const text = locator ? `${number}, ${locator}` : String(number);
        return link(item.key, `[${text}]`);
      });
      if (!narrative) return { html: parts.join(", ") };
      const first = known[0] as CitationItem;
      const record = this.byKey.get(first.key) as EvidenceRecord;
      return { html: `${escapeHtml(this.inTextAuthors(record))} ${parts.join(", ")}` };
    }
    // author-date
    if (narrative) {
      const parts = known.map((item) => {
        const record = this.byKey.get(item.key) as EvidenceRecord;
        const locator = this.locatorText(item);
        const tail = locator ? `${this.yearOf(record)}, ${locator}` : this.yearOf(record);
        return `${escapeHtml(this.inTextAuthors(record))} (${link(item.key, tail)})`;
      });
      return { html: parts.join("; ") };
    }
    const parts = known.map((item) => {
      const record = this.byKey.get(item.key) as EvidenceRecord;
      const locator = this.locatorText(item);
      const text = `${this.inTextAuthors(record)}, ${this.yearOf(record)}${locator ? `, ${locator}` : ""}`;
      return link(item.key, text);
    });
    return { html: `(${parts.join("; ")})` };
  }

  /** Footnote text of a note-style citation: full the first time, short afterwards. */
  private note(item: CitationItem): string {
    const record = this.byKey.get(item.key) as EvidenceRecord;
    const locator = this.locatorText(item);
    const place = locator ? `, ${escapeHtml(locator)}` : "";
    if (this.noted.has(item.key)) {
      const family = this.family1(record);
      const lead = family ? `${escapeHtml(family)}, ` : "";
      const short = this.shortTitle(record);
      return `${lead}${em(short)}${place}${short.endsWith("…") ? "" : "."}`;
    }
    this.noted.add(item.key);
    return `${this.noteEntry(record)}${locator ? ` ${escapeHtml(locator)}.` : ""}`;
  }

  // -------------------------------------------------------------------------------------------
  // Bibliography
  // -------------------------------------------------------------------------------------------

  private link(record: EvidenceRecord): string {
    const target = record.doi ? `https://doi.org/${record.doi}` : record.url;
    return target ? escapeHtml(target) : "";
  }

  private typeLabel(record: EvidenceRecord): string | undefined {
    const label = this.strings[`evidence_${record.type}`];
    return label ? `[${label}]` : undefined;
  }

  private volumeIssue(record: EvidenceRecord): string {
    if (!record.volume && !record.issue) return "";
    const volume = record.volume ? `${this.w.vol} ${record.volume}` : "";
    const issue = record.issue ? `${this.w.no} ${record.issue}` : "";
    return [volume, issue].filter(Boolean).join(", ");
  }

  private apaEntry(record: EvidenceRecord): string {
    const authors = this.apaAuthors(record);
    const year = `(${this.yearOf(record)})`;
    const lead = authors ? `${escapeHtml(stripTrailingPeriod(authors))}. ${year}.` : `${year}.`;
    const parts: string[] = [lead];
    const label = this.typeLabel(record);
    const url = this.link(record);
    switch (record.type) {
      case "journal_article": {
        parts.push(`${escapeHtml(stripTrailingPeriod(record.title))}.`);
        const container = record.containerTitle ? em(record.containerTitle) : "";
        const numbers = [
          record.volume ? `<em>${escapeHtml(record.volume)}</em>` : "",
          record.issue ? `(${escapeHtml(record.issue)})` : "",
        ].join("");
        const pages = record.pages ? escapeHtml(record.pages) : "";
        const tail = [container, [numbers, pages].filter(Boolean).join(", ")].filter(Boolean);
        if (tail.length) parts.push(`${tail.join(", ")}.`);
        break;
      }
      case "chapter":
      case "conference_paper": {
        parts.push(`${escapeHtml(stripTrailingPeriod(record.title))}.`);
        if (record.containerTitle)
          parts.push(
            `${escapeHtml(this.w.inWord)} ${em(record.containerTitle)}${record.pages ? ` (${escapeHtml(this.w.pp)} ${escapeHtml(record.pages)})` : ""}.`,
          );
        if (record.publisher) parts.push(`${escapeHtml(record.publisher)}.`);
        break;
      }
      default: {
        parts.push(
          `${em(stripTrailingPeriod(record.title))}${label ? ` ${escapeHtml(label)}` : ""}.`,
        );
        if (record.containerTitle) parts.push(`${escapeHtml(record.containerTitle)}.`);
        if (record.publisher) parts.push(`${escapeHtml(record.publisher)}.`);
      }
    }
    if (url) parts.push(url);
    return parts.join(" ");
  }

  private ieeeEntry(record: EvidenceRecord): string {
    const authors = this.ieeeAuthors(record);
    const parts: string[] = [];
    if (authors) parts.push(`${escapeHtml(authors)},`);
    const title = escapeHtml(stripTrailingPeriod(record.title));
    const periodical = ["journal_article", "chapter", "conference_paper"].includes(record.type);
    if (periodical) {
      parts.push(`“${title},”`);
      if (record.containerTitle) parts.push(`${em(record.containerTitle)},`);
    } else parts.push(`${em(stripTrailingPeriod(record.title))},`);
    const details = [
      this.volumeIssue(record),
      record.pages ? `${this.w.pp} ${record.pages}` : "",
      !periodical && record.publisher ? record.publisher : "",
      record.year ? String(record.year) : this.w.noDate,
    ].filter(Boolean);
    parts.push(`${escapeHtml(details.join(", "))}.`);
    const url = this.link(record);
    if (url) parts.push(url);
    return parts.join(" ");
  }

  /** ICONTEC-like entry: `FAMILY, Given. Title. Place: Publisher, Year.` */
  private noteEntry(record: EvidenceRecord): string {
    const authors = this.icontecAuthors(record);
    const parts: string[] = [];
    if (authors) parts.push(`${escapeHtml(stripTrailingPeriod(authors))}.`);
    const periodical = ["journal_article", "chapter", "conference_paper"].includes(record.type);
    parts.push(
      periodical
        ? `${escapeHtml(stripTrailingPeriod(record.title))}.`
        : `${em(stripTrailingPeriod(record.title))}.`,
    );
    if (periodical && record.containerTitle) {
      const details = [this.volumeIssue(record), record.pages ? `${this.w.pp} ${record.pages}` : ""]
        .filter(Boolean)
        .join(", ");
      parts.push(
        `${em(record.containerTitle)}${details ? `, ${escapeHtml(details)}` : ""}, ${record.year || this.w.noDate}.`,
      );
    } else {
      const place = record.placeOfPublication ? `${record.placeOfPublication}: ` : "";
      const publisher = record.publisher ? `${place}${record.publisher}, ` : "";
      parts.push(`${escapeHtml(`${publisher}${record.year || this.w.noDate}`)}.`);
    }
    const url = this.link(record);
    if (url) parts.push(url);
    return parts.join(" ");
  }

  /** The reference list for the keys cited so far, in the order of the style family. */
  bibliography(): BibliographyEntryHtml[] {
    const records = this.cited.map((key) => this.byKey.get(key) as EvidenceRecord);
    if (this.family === "numeric") {
      return records
        .map((record) => ({ record, number: this.numbers.get(record.citeKey) as number }))
        .sort((a, b) => a.number - b.number)
        .map(({ record, number }) => ({
          key: record.citeKey,
          label: `[${number}]`,
          html: this.ieeeEntry(record),
        }));
    }
    const sorted = [...records].sort((a, b) => {
      const left = (this.family1(a) ?? a.title).toLocaleLowerCase();
      const right = (this.family1(b) ?? b.title).toLocaleLowerCase();
      return left.localeCompare(right) || a.year - b.year || a.title.localeCompare(b.title);
    });
    return sorted.map((record) => ({
      key: record.citeKey,
      html: this.family === "note" ? this.noteEntry(record) : this.apaEntry(record),
    }));
  }
}
