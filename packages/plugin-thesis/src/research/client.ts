import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripControl } from "../schemas.js";
import { atomicWrite } from "../storage.js";
import type { EvidenceType } from "../types.js";
import { VERSION } from "../version.js";

/** Fixed scholarly origins (spec 8.2). Nothing else is ever contacted by this client. */
export const origins = {
  openalex: "https://api.openalex.org",
  crossref: "https://api.crossref.org",
  arxiv: "https://export.arxiv.org",
} as const;
export type ScholarSource = keyof typeof origins;

export const limits = {
  timeoutMs: 8000,
  responseBytes: 1024 * 1024,
  arxivSpacingMs: 3000,
} as const;

export type ScholarType = EvidenceType | "other";

/** Structured, sanitized and capped record (spec 5.5). Missing scalars are `null`. */
export interface ScholarRecord {
  id: string;
  doi: string | null;
  title: string;
  authors: { family: string; given: string | null; orcid: string | null }[];
  year: number | null;
  containerTitle: string | null;
  type: ScholarType;
  publisher: string | null;
  /** City of publication when the source states one (Crossref `publisher-location`). */
  placeOfPublication?: string;
  issn: string | null;
  isbn: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  language: string | null;
  url: string | null;
  oaUrl: string | null;
  license: string | null;
  abstract: string | null;
  source: ScholarSource;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("source unavailable"));
        },
        { once: true },
      );
    }),
};

export interface ScholarClientOptions {
  fetch?: typeof fetch;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type Identifier =
  | { kind: "doi"; value: string }
  | { kind: "arxiv"; value: string }
  | { kind: "openalex"; value: string }
  | { kind: "url"; value: string };

export interface SearchInput {
  query: string;
  source: ScholarSource;
  limit: number;
  fromYear?: number;
  toYear?: number;
  language?: string;
}

export interface ResolvedRecord {
  record: ScholarRecord;
  retracted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------------------------

/** Remove control characters and markup noise, collapse whitespace and cap the length. */
export function clean(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const text = stripControl(decodeEntities(value.replace(/<[^>]*>/g, " ")))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || null;
}

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isInteger(code) && code > 31 && code < 0x110000
        ? String.fromCodePoint(code)
        : "";
    }
    return namedEntities[body] ?? whole;
  });
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    const text = url.toString();
    return text.length <= 500 ? text : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const firstString = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

function year(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 1000 && number <= 2200 ? number : null;
}

function bareOrcid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/.exec(value);
  return match ? (match[1] as string) : null;
}

const maxAuthors = 50;

function bareDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S{1,200}$/.test(doi) ? doi : null;
}

// ---------------------------------------------------------------------------------------------
// Identifiers and input
// ---------------------------------------------------------------------------------------------

export function parseIdentifier(raw: unknown): Identifier {
  if (typeof raw !== "string") throw new Error("invalid identifier");
  const text = raw.trim();
  if (text.length < 1 || text.length > 2048) throw new Error("invalid identifier");
  let value = text;
  try {
    value = decodeURIComponent(text);
  } catch {
    // keep the raw text
  }
  value = value
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();
  if (/^10\.\d{4,9}\/[^\s]{1,200}$/i.test(value))
    return { kind: "doi", value: value.toLowerCase() };
  const arxivUrl = /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i.exec(value);
  const arxiv = /^(?:arxiv:)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v\d+)?$/i.exec(
    arxivUrl ? (arxivUrl[1] as string) : value,
  );
  if (arxiv) return { kind: "arxiv", value: (arxiv[1] as string).toLowerCase() };
  const openalex = /^(?:https?:\/\/openalex\.org\/)?(W\d{1,12})$/i.exec(value);
  if (openalex) return { kind: "openalex", value: (openalex[1] as string).toUpperCase() };
  const url = safeUrl(value);
  if (url) {
    const parsed = new URL(url);
    parsed.hash = "";
    return { kind: "url", value: parsed.toString() };
  }
  throw new Error("invalid identifier");
}

const yearBounds = { min: 1600, max: new Date().getUTCFullYear() + 1 };

export function parseSearchInput(input: unknown): SearchInput {
  if (!isRecord(input)) throw new Error("invalid input");
  const allowed = ["query", "source", "limit", "fromYear", "toYear", "language"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("invalid input");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length < 1 || query.length > 512) throw new Error("invalid input");
  if (input.source !== "openalex" && input.source !== "crossref" && input.source !== "arxiv") {
    throw new Error("invalid input");
  }
  let limit = 10;
  if (input.limit !== undefined) {
    if (
      !Number.isInteger(input.limit) ||
      (input.limit as number) < 1 ||
      (input.limit as number) > 25
    ) {
      throw new Error("invalid input");
    }
    limit = input.limit as number;
  }
  const result: SearchInput = { query: stripControl(query), source: input.source, limit };
  for (const key of ["fromYear", "toYear"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      !Number.isInteger(value) ||
      (value as number) < yearBounds.min ||
      (value as number) > yearBounds.max
    ) {
      throw new Error("invalid input");
    }
    result[key] = value as number;
  }
  if (result.fromYear && result.toYear && result.fromYear > result.toYear)
    throw new Error("invalid input");
  if (input.language !== undefined) {
    if (typeof input.language !== "string" || !/^[a-z]{2,3}$/i.test(input.language)) {
      throw new Error("invalid input");
    }
    result.language = input.language.toLowerCase();
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Normalizers (pure; exercised by recorded fixtures)
// ---------------------------------------------------------------------------------------------

const crossrefTypes: Record<string, ScholarType> = {
  "journal-article": "journal_article",
  "proceedings-article": "conference_paper",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "reference-entry": "chapter",
  dissertation: "thesis",
  report: "report",
  "report-component": "report",
  standard: "standard",
  dataset: "dataset",
  "posted-content": "preprint",
};

const openalexTypes: Record<string, ScholarType> = {
  article: "journal_article",
  book: "book",
  "book-chapter": "chapter",
  dissertation: "thesis",
  dataset: "dataset",
  report: "report",
  standard: "standard",
  preprint: "preprint",
};

function crossrefRetracted(item: Record<string, unknown>): boolean {
  const isRetraction = (entry: unknown) =>
    isRecord(entry) && typeof entry.type === "string" && /retract/i.test(entry.type);
  if (asArray(item["update-to"]).some(isRetraction)) return true;
  if (asArray(item["updated-by"]).some(isRetraction)) return true;
  const relation = item.relation;
  return isRecord(relation) && Object.keys(relation).some((key) => /retract/i.test(key));
}

export function normalizeCrossref(item: unknown): ResolvedRecord | undefined {
  if (!isRecord(item)) return undefined;
  const doi = bareDoi(item.DOI);
  const title = clean(firstString(item.title), 500);
  if (!title) return undefined;
  const issued =
    firstDateYear(item.issued) ??
    firstDateYear(item["published-print"]) ??
    firstDateYear(item["published-online"]);
  const authors = asArray(item.author)
    .filter(isRecord)
    .slice(0, maxAuthors)
    .map((author) => {
      const family = clean(author.family, 120) ?? clean(author.name, 200);
      return family
        ? { family, given: clean(author.given, 120), orcid: bareOrcid(author.ORCID) }
        : undefined;
    })
    .filter((author): author is NonNullable<typeof author> => author !== undefined);
  const license = asArray(item.license).find(isRecord);
  const type = crossrefTypes[typeof item.type === "string" ? item.type : ""] ?? "other";
  const isbn = asArray(item.ISBN)[0];
  const record: ScholarRecord = {
    id: doi ?? title,
    doi,
    title,
    authors,
    year: issued,
    containerTitle: clean(firstString(item["container-title"]), 300),
    type,
    publisher: clean(item.publisher, 200),
    ...(clean(item["publisher-location"], 120)
      ? { placeOfPublication: clean(item["publisher-location"], 120) as string }
      : {}),
    issn: clean(asArray(item.ISSN)[0], 20),
    isbn: clean(isbn, 20),
    volume: clean(item.volume, 40),
    issue: clean(item.issue, 40),
    pages: clean(item.page, 40),
    language: clean(item.language, 12),
    url: safeUrl(item.URL) ?? (doi ? `https://doi.org/${doi}` : null),
    oaUrl: null,
    license: license ? safeUrl(license.URL) : null,
    abstract: clean(item.abstract, 2000),
    source: "crossref",
  };
  return { record, retracted: crossrefRetracted(item) };
}

function firstDateYear(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const parts = asArray(value["date-parts"])[0];
  return year(asArray(parts)[0]);
}

function invertedAbstract(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(value)) {
    for (const position of asArray(positions)) {
      if (Number.isInteger(position) && (position as number) >= 0 && (position as number) < 20000) {
        words.push([position as number, word]);
      }
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return clean(words.map(([, word]) => word).join(" "), 2000);
}

export function normalizeOpenAlex(item: unknown): ResolvedRecord | undefined {
  if (!isRecord(item)) return undefined;
  const title = clean(item.display_name ?? item.title, 500);
  if (!title) return undefined;
  const id = typeof item.id === "string" ? /(W\d{1,12})$/.exec(item.id)?.[1] : undefined;
  const doi = bareDoi(item.doi);
  const location = isRecord(item.primary_location) ? item.primary_location : {};
  const source = isRecord(location.source) ? location.source : {};
  const access = isRecord(item.open_access) ? item.open_access : {};
  const biblio = isRecord(item.biblio) ? item.biblio : {};
  const authors = asArray(item.authorships)
    .filter(isRecord)
    .slice(0, maxAuthors)
    .map((entry) => {
      const author = isRecord(entry.author) ? entry.author : {};
      const name = clean(author.display_name, 200);
      if (!name) return undefined;
      const parts = name.split(" ");
      const family = parts.length > 1 ? (parts.pop() as string) : name;
      return {
        family,
        given: parts.length > 0 ? parts.join(" ") : null,
        orcid: bareOrcid(author.orcid),
      };
    })
    .filter((author): author is NonNullable<typeof author> => author !== undefined);
  let type: ScholarType = openalexTypes[typeof item.type === "string" ? item.type : ""] ?? "other";
  if (type === "journal_article" && source.type === "conference") type = "conference_paper";
  if (type === "journal_article" && source.type === "repository") type = "preprint";
  const first = clean(biblio.first_page, 20);
  const last = clean(biblio.last_page, 20);
  const record: ScholarRecord = {
    id: id ?? doi ?? title,
    doi,
    title,
    authors,
    year: year(item.publication_year),
    containerTitle: clean(source.display_name, 300),
    type,
    publisher: clean(source.host_organization_name, 200),
    issn: clean(source.issn_l, 20),
    isbn: null,
    volume: clean(biblio.volume, 40),
    issue: clean(biblio.issue, 40),
    pages: first && last ? `${first}-${last}` : first,
    language: clean(item.language, 12),
    url: safeUrl(location.landing_page_url) ?? (doi ? `https://doi.org/${doi}` : null),
    oaUrl: safeUrl(access.oa_url),
    license: clean(location.license, 60),
    abstract: invertedAbstract(item.abstract_inverted_index),
    source: "openalex",
  };
  return { record, retracted: item.is_retracted === true };
}

function xmlText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? clean(match[1], 2000) : null;
}

export function normalizeArxiv(xml: string): ScholarRecord[] {
  const records: ScholarRecord[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1] as string;
    const idUrl = xmlText(block, "id");
    const id = idUrl
      ? /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/i.exec(idUrl)?.[1]?.toLowerCase()
      : undefined;
    const title = clean(xmlText(block, "title"), 500);
    if (!id || !title) continue;
    const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)]
      .slice(0, maxAuthors)
      .map((author) => clean(author[1], 200))
      .filter((name): name is string => name !== null)
      .map((name) => {
        const parts = name.split(" ");
        const family = parts.length > 1 ? (parts.pop() as string) : name;
        return { family, given: parts.length > 0 ? parts.join(" ") : null, orcid: null };
      });
    const published = xmlText(block, "published");
    records.push({
      id,
      doi: bareDoi(xmlText(block, "arxiv:doi")),
      title,
      authors,
      year: published ? year(published.slice(0, 4)) : null,
      containerTitle: clean(xmlText(block, "arxiv:journal_ref"), 300),
      type: "preprint",
      publisher: "arXiv",
      issn: null,
      isbn: null,
      volume: null,
      issue: null,
      pages: null,
      language: "en",
      url: `https://arxiv.org/abs/${id}`,
      oaUrl: `https://arxiv.org/pdf/${id}`,
      license: null,
      abstract: xmlText(block, "summary"),
      source: "arxiv",
    });
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

const openalexSelect = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "authorships",
  "primary_location",
  "type",
  "language",
  "open_access",
  "biblio",
  "is_retracted",
  "abstract_inverted_index",
].join(",");

const contactPattern = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/;

/** Resolved records are cached for 24 hours (spec 15). */
export const resolveCacheTtlMs = 24 * 60 * 60 * 1000;

export class ScholarClient {
  private cacheDir: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private crossrefTail: Promise<unknown> = Promise.resolve();
  private arxivNext = 0;

  constructor(options: ScholarClientOptions = {}) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? realClock;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? limits.timeoutMs;
  }

  /** Cache resolved records under `dir` (for example `<thesis>/build/cache/scholar`). */
  useCache(dir: string | undefined): void {
    this.cacheDir = dir;
  }

  private cacheFile(identifier: Identifier): string | undefined {
    if (!this.cacheDir) return undefined;
    const key = createHash("sha256").update(`${identifier.kind}:${identifier.value}`).digest("hex");
    return join(this.cacheDir, `${key}.json`);
  }

  private async readCache(identifier: Identifier): Promise<ResolvedRecord | undefined> {
    const file = this.cacheFile(identifier);
    if (!file) return undefined;
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as {
        at?: unknown;
        resolved?: ResolvedRecord;
      };
      if (
        typeof entry.at === "number" &&
        this.clock.now() - entry.at < resolveCacheTtlMs &&
        entry.at <= this.clock.now() &&
        entry.resolved?.record &&
        typeof entry.resolved.retracted === "boolean"
      ) {
        return entry.resolved;
      }
    } catch {
      // A missing or damaged cache entry is a miss.
    }
    return undefined;
  }

  private async writeCache(identifier: Identifier, resolved: ResolvedRecord): Promise<void> {
    const file = this.cacheFile(identifier);
    if (!file) return;
    try {
      await atomicWrite(file, `${JSON.stringify({ at: this.clock.now(), resolved })}\n`);
    } catch {
      // The cache is an optimization; a read-only workspace must not fail the lookup.
    }
  }

  /** Optional polite-pool contact; read per call from the environment, never stored or logged. */
  private contact(): string | undefined {
    const value = this.env.ALISIO_THESIS_CONTACT_EMAIL?.trim();
    return value && contactPattern.test(value) ? value : undefined;
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<ScholarRecord[]> {
    const records = (await this.searchSource(input, signal)).slice(0, input.limit);
    return records.filter(
      (record) =>
        (input.fromYear === undefined || record.year === null || record.year >= input.fromYear) &&
        (input.toYear === undefined || record.year === null || record.year <= input.toYear),
    );
  }

  private async searchSource(input: SearchInput, signal?: AbortSignal): Promise<ScholarRecord[]> {
    const query = new URLSearchParams();
    if (input.source === "openalex") {
      query.set("search", input.query);
      query.set("per-page", String(input.limit));
      query.set("select", openalexSelect);
      const filters: string[] = [];
      if (input.fromYear) filters.push(`from_publication_date:${input.fromYear}-01-01`);
      if (input.toYear) filters.push(`to_publication_date:${input.toYear}-12-31`);
      if (input.language) filters.push(`language:${input.language}`);
      if (filters.length) query.set("filter", filters.join(","));
      const contact = this.contact();
      if (contact) query.set("mailto", contact);
      const body = await this.request("openalex", `/works?${query}`, signal);
      return asArray((parseJson(body) as Record<string, unknown>).results)
        .map(normalizeOpenAlex)
        .filter((entry): entry is ResolvedRecord => entry !== undefined)
        .map((entry) => entry.record);
    }
    if (input.source === "crossref") {
      query.set("query.bibliographic", input.query);
      query.set("rows", String(input.limit));
      const filters: string[] = [];
      if (input.fromYear) filters.push(`from-pub-date:${input.fromYear}`);
      if (input.toYear) filters.push(`until-pub-date:${input.toYear}`);
      if (filters.length) query.set("filter", filters.join(","));
      const message = (
        parseJson(await this.request("crossref", `/works?${query}`, signal)) as Record<
          string,
          unknown
        >
      ).message;
      return asArray(isRecord(message) ? message.items : undefined)
        .map(normalizeCrossref)
        .filter((entry): entry is ResolvedRecord => entry !== undefined)
        .map((entry) => entry.record);
    }
    query.set("search_query", `all:${input.query.replace(/["\\]/g, " ")}`);
    query.set("start", "0");
    query.set("max_results", String(input.limit));
    query.set("sortBy", "relevance");
    return normalizeArxiv(await this.request("arxiv", `/api/query?${query}`, signal));
  }

  async resolve(identifier: Identifier, signal?: AbortSignal): Promise<ResolvedRecord | undefined> {
    if (identifier.kind === "url") return undefined;
    const cached = await this.readCache(identifier);
    if (cached) return cached;
    const resolved = await this.resolveRemote(identifier, signal);
    if (resolved) await this.writeCache(identifier, resolved);
    return resolved;
  }

  private async resolveRemote(
    identifier: Identifier,
    signal?: AbortSignal,
  ): Promise<ResolvedRecord | undefined> {
    if (identifier.kind === "arxiv") {
      const query = new URLSearchParams({ id_list: identifier.value });
      const [record] = normalizeArxiv(await this.request("arxiv", `/api/query?${query}`, signal));
      return record ? { record, retracted: false } : undefined;
    }
    if (identifier.kind === "openalex") {
      return this.openalexWork(identifier.value, signal);
    }
    // DOI: Crossref first, OpenAlex when Crossref does not know it.
    const path = identifier.value.split("/").map(encodeURIComponent).join("/");
    const contact = this.contact();
    try {
      const body = parseJson(
        await this.request(
          "crossref",
          `/works/${path}${contact ? `?mailto=${encodeURIComponent(contact)}` : ""}`,
          signal,
        ),
      ) as Record<string, unknown>;
      return normalizeCrossref(body.message);
    } catch (error) {
      if ((error as Error).message !== "record not found") throw error;
    }
    return this.openalexWork(`doi:https://doi.org/${identifier.value}`, signal);
  }

  private async openalexWork(
    id: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRecord | undefined> {
    const query = new URLSearchParams({ select: openalexSelect });
    const contact = this.contact();
    if (contact) query.set("mailto", contact);
    try {
      return normalizeOpenAlex(
        parseJson(await this.request("openalex", `/works/${encodeURI(id)}?${query}`, signal)),
      );
    } catch (error) {
      if ((error as Error).message === "record not found") return undefined;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------

  private request(source: ScholarSource, path: string, outer?: AbortSignal): Promise<string> {
    if (source === "crossref") {
      // Single flight: at most one Crossref request is in progress; callers queue behind it.
      const run = this.crossrefTail.then(
        () => this.send(source, path, outer),
        () => this.send(source, path, outer),
      );
      this.crossrefTail = run.catch(() => undefined);
      return run;
    }
    return this.send(source, path, outer);
  }

  private async send(source: ScholarSource, path: string, outer?: AbortSignal): Promise<string> {
    outer?.throwIfAborted();
    if (source === "arxiv") {
      const slot = Math.max(this.clock.now(), this.arxivNext);
      this.arxivNext = slot + limits.arxivSpacingMs;
      const wait = slot - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait, outer);
    }
    const signal = outer
      ? AbortSignal.any([outer, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    const contact = this.contact();
    let response: Response;
    try {
      response = await this.fetcher(`${origins[source]}${path}`, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: source === "arxiv" ? "application/atom+xml" : "application/json",
          "user-agent": `alisio-plugin-thesis/${VERSION}${source === "crossref" && contact ? ` (mailto:${contact})` : ""}`,
        },
        signal,
      });
    } catch {
      throw new Error("source unavailable");
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error("source returned redirect");
    if (response.status === 404) throw new Error("record not found");
    if (response.status === 429) throw new Error("source rate limited");
    if (!response.ok) throw new Error("source unavailable");
    if (response.redirected) throw new Error("source returned redirect");
    return readCapped(response, signal);
  }
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limits.responseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response exceeded limit");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if ((error as Error).message === "response exceeded limit") throw error;
    throw new Error("source unavailable");
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("source unavailable");
  }
}
