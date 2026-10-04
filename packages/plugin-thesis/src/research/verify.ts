import type { ComplianceProfile } from "../policy/resolver.js";
import {
  type EvidenceRecord,
  type EvidenceStatus,
  type EvidenceType,
  evidenceStatuses,
} from "../types.js";
import {
  type Identifier,
  parseIdentifier,
  type ScholarClient,
  type ScholarRecord,
} from "./client.js";

// ---------------------------------------------------------------------------------------------
// Text normalization (spec 8.4: lowercase, accent folding, per-language stop words)
// ---------------------------------------------------------------------------------------------

const stopWordLists: Record<string, readonly string[]> = {
  en: "a an and are as at be by for from in into is it of on or that the their this to with without using use via based".split(
    " ",
  ),
  es: "a al ante con contra de del desde el en entre es la las lo los o para por que se segun sin sobre su sus un una uno unas unos y como mediante usando basado".split(
    " ",
  ),
  pt: "a ao aos as com contra de do dos da das e em entre o os ou para pelo pela por que se sem sobre um uma uns umas como usando baseado".split(
    " ",
  ),
  fr: "a au aux avec ce ces dans de des du en et la le les ou par pour sur un une sans sous comme".split(
    " ",
  ),
};

/** Lowercase, remove diacritics. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function stopWordsFor(language: string | null | undefined): Set<string> {
  const primary = language ? fold(language).split(/[-_]/)[0] : undefined;
  const list = primary ? stopWordLists[primary] : undefined;
  if (list) return new Set(list);
  return new Set([
    ...(stopWordLists.en ?? []),
    ...(stopWordLists.es ?? []),
    ...(stopWordLists.pt ?? []),
  ]);
}

export function titleTokens(title: string, language?: string | null): Set<string> {
  const stop = stopWordsFor(language);
  return new Set(
    fold(title)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !stop.has(token)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function titleSimilarity(a: string, b: string, language?: string | null): number {
  return jaccard(titleTokens(a, language), titleTokens(b, language));
}

/** Stable key for duplicate detection: folded title tokens in order, plus the year. */
export function titleKey(title: string): string {
  return fold(title)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

export function foldFamily(name: string): string {
  return fold(name).replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------------------------------------
// Official domains (offline matching; reachability is never tested)
// ---------------------------------------------------------------------------------------------

export interface OfficialDomains {
  primary: { hosts: string[]; allowedTypes: EvidenceType[] }[];
  indexing: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.toLowerCase())
    : [];

export const officialDomainsFromProfile = (
  profile: ComplianceProfile | undefined,
): OfficialDomains => {
  const result: OfficialDomains = { primary: [], indexing: [] };
  for (const rule of profile?.rules ?? []) {
    if (rule.kind !== "official_domain_allowlist") continue;
    const hosts = [
      ...strings(rule.values.hostSuffixes),
      ...strings(rule.values.explicitHosts),
      ...strings(rule.values.otherHosts),
    ];
    if (rule.values.tier === "indexing") result.indexing.push(...hosts);
    else
      result.primary.push({
        hosts,
        allowedTypes: strings(rule.values.allowedTypes) as EvidenceType[],
      });
  }
  return result;
};

/** The lowercase hostname of an http(s) URL without credentials; undefined otherwise. */
export function hostOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

const hostMatches = (host: string, entry: string) => host === entry || host.endsWith(`.${entry}`);

export const primaryTypes: readonly EvidenceType[] = ["law", "standard", "report", "dataset"];

export type DomainDecision =
  | { tier: "primary" }
  | { tier: "indexing" }
  | { tier: "type_not_allowed" }
  | { tier: "none" };

export function classifyHost(
  url: string | undefined | null,
  type: EvidenceType | undefined,
  domains: OfficialDomains,
): DomainDecision {
  const host = hostOf(url);
  if (!host) return { tier: "none" };
  if (domains.indexing.some((entry) => hostMatches(host, entry))) return { tier: "indexing" };
  const matching = domains.primary.filter((group) =>
    group.hosts.some((entry) => hostMatches(host, entry)),
  );
  if (matching.length === 0) return { tier: "none" };
  const allowed =
    type !== undefined &&
    primaryTypes.includes(type) &&
    matching.some((group) => group.allowedTypes.length === 0 || group.allowedTypes.includes(type));
  return allowed ? { tier: "primary" } : { tier: "type_not_allowed" };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/** What a child claims about a candidate; code compares it with what the source returns. */
export interface Candidate {
  identifier: string;
  title: string;
  firstAuthor?: string | null;
  year: number;
  type?: EvidenceType;
  url?: string;
  language?: string;
  /** The user supplied this source; there is no claimed metadata to compare with. */
  userSupplied?: boolean;
}

export type RecordDraft = Pick<
  EvidenceRecord,
  | "type"
  | "title"
  | "authors"
  | "year"
  | "containerTitle"
  | "volume"
  | "issue"
  | "pages"
  | "publisher"
  | "placeOfPublication"
  | "doi"
  | "isbn"
  | "issn"
  | "url"
  | "language"
  | "verification"
  | "status"
>;

export interface VerificationResult {
  status: EvidenceStatus;
  /** Machine reason when the status is UNVERIFIED or REJECTED. */
  reason?: string;
  detail?: string;
  /** Present whenever a source answered, even for UNVERIFIED/REJECTED outcomes. */
  record?: RecordDraft;
  /** Abstract of the resolved record (not persisted); helps the auditor appraise relevance. */
  abstract?: string;
}

export interface VerifyContext {
  client: Pick<ScholarClient, "resolve">;
  domains: OfficialDomains;
  now: () => Date;
  signal?: AbortSignal;
  /** Ask OpenAlex too after a Crossref hit, so `is_retracted` is honored (default true). */
  crossCheckRetraction?: boolean;
}

export const similarityThreshold = 0.85;

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}

function draftFromScholar(
  record: ScholarRecord,
  status: EvidenceStatus,
  metadataMatch: number,
  retracted: boolean,
  now: Date,
): RecordDraft {
  const type: EvidenceType = record.type === "other" ? "web_page" : record.type;
  return compact({
    type,
    title: record.title,
    authors: record.authors.map((author) =>
      compact({
        family: author.family,
        given: author.given ?? undefined,
        orcid: author.orcid ?? undefined,
      }),
    ),
    year: record.year as number,
    containerTitle: record.containerTitle ?? undefined,
    volume: record.volume ?? undefined,
    issue: record.issue ?? undefined,
    pages: record.pages ?? undefined,
    publisher: record.publisher ?? undefined,
    placeOfPublication: record.placeOfPublication ?? undefined,
    doi: record.doi ?? undefined,
    isbn: record.isbn ?? undefined,
    issn: record.issn ?? undefined,
    url: record.url ?? record.oaUrl ?? undefined,
    language: record.language ?? undefined,
    verification: {
      method: record.source,
      metadataMatch: Math.round(metadataMatch * 1000) / 1000,
      retracted,
      checkedAt: now.toISOString(),
    },
    status,
  }) as RecordDraft;
}

function classifyResolved(record: ScholarRecord): EvidenceStatus {
  switch (record.type) {
    case "journal_article":
    case "conference_paper":
      return "VERIFIED_PEER_REVIEWED";
    case "book":
    case "chapter":
    case "report":
    case "dataset":
    case "standard":
      return "VERIFIED_AUTHORITATIVE_GREY";
    default:
      return "CONTEXTUAL_ONLY";
  }
}

/** First-author and year checks of spec 8.4. A claim without authors cannot match an authored record. */
function mismatch(candidate: Candidate, record: ScholarRecord): string | undefined {
  const similarity = titleSimilarity(
    candidate.title,
    record.title,
    record.language ?? candidate.language,
  );
  if (similarity < similarityThreshold)
    return `title similarity ${similarity.toFixed(2)} is below ${similarityThreshold}`;
  const first = record.authors[0];
  if (first) {
    const claimed = candidate.firstAuthor ? foldFamily(candidate.firstAuthor) : "";
    if (claimed !== foldFamily(first.family)) return "first author does not match";
  }
  if (record.year === null) return "the source has no publication year";
  if (Math.abs(record.year - candidate.year) > 1)
    return `year ${candidate.year} is not within one year of ${record.year}`;
  return undefined;
}

/** The status code would give a resolved record whose metadata matches (spec 8.4). */
export function suggestStatus(
  record: ScholarRecord,
  domains: OfficialDomains,
  extraUrl?: string,
): EvidenceStatus {
  // A DOI-resolved report, standard or dataset can still be primary when an official URL backs it.
  const type: EvidenceType = record.type === "other" ? "web_page" : record.type;
  for (const url of [extraUrl, record.url]) {
    if (classifyHost(url, type, domains).tier === "primary") return "VERIFIED_PRIMARY";
  }
  return classifyResolved(record);
}

/**
 * Resolve an identifier; after a Crossref hit also ask OpenAlex so `is_retracted` is honored.
 * Throws the client's fixed error messages when a source is unavailable.
 */
export async function resolveChecked(
  client: Pick<ScholarClient, "resolve">,
  identifier: Identifier,
  signal?: AbortSignal,
  crossCheck = true,
): Promise<{ record: ScholarRecord; retracted: boolean } | undefined> {
  const resolved = await client.resolve(identifier, signal);
  if (!resolved) return undefined;
  let retracted = resolved.retracted;
  if (!retracted && crossCheck && resolved.record.source === "crossref" && resolved.record.doi) {
    try {
      const other = await client.resolve(
        { kind: "openalex", value: `doi:https://doi.org/${resolved.record.doi}` },
        signal,
      );
      retracted = other?.retracted === true;
    } catch {
      // Fail open: the Crossref answer stands when OpenAlex is unavailable.
    }
  }
  return { record: resolved.record, retracted };
}

export async function verifyCandidate(
  candidate: Candidate,
  context: VerifyContext,
): Promise<VerificationResult> {
  const now = context.now();
  let identifier: Identifier;
  try {
    identifier = parseIdentifier(candidate.identifier);
  } catch {
    return { status: "UNVERIFIED", reason: "invalid_identifier" };
  }

  if (identifier.kind === "url")
    return verifyOfficialUrl(candidate, identifier.value, context, now);

  let resolved: Awaited<ReturnType<typeof resolveChecked>>;
  try {
    resolved = await resolveChecked(
      context.client,
      identifier,
      context.signal,
      context.crossCheckRetraction !== false,
    );
  } catch (error) {
    return { status: "UNVERIFIED", reason: "source_unavailable", detail: (error as Error).message };
  }
  if (!resolved)
    return {
      status: "UNVERIFIED",
      reason: identifier.kind === "doi" ? "doi_not_found" : "not_found",
    };

  const { record, retracted } = resolved;

  const problem = candidate.userSupplied ? undefined : mismatch(candidate, record);
  const similarity = candidate.userSupplied
    ? 1
    : titleSimilarity(candidate.title, record.title, record.language ?? candidate.language);
  if (problem) {
    return {
      status: "UNVERIFIED",
      reason: identifier.kind === "doi" ? "doi_mismatch" : "metadata_mismatch",
      detail: problem,
      record: draftFromScholar(record, "UNVERIFIED", similarity, retracted, now),
    };
  }
  if (record.year === null) return { status: "UNVERIFIED", reason: "no_year" };
  const abstract = record.abstract?.slice(0, 600);
  if (retracted) {
    return {
      status: "REJECTED",
      reason: "retracted",
      record: draftFromScholar(record, "REJECTED", similarity, true, now),
    };
  }

  const status = suggestStatus(record, context.domains, candidate.url);
  if (status === "VERIFIED_PRIMARY") {
    const draft = draftFromScholar(record, status, similarity, false, now);
    const type: EvidenceType = record.type === "other" ? "web_page" : record.type;
    draft.url = [candidate.url, record.url].find(
      (url) => classifyHost(url, type, context.domains).tier === "primary",
    ) as string;
    return { status, record: draft, ...(abstract ? { abstract } : {}) };
  }
  return {
    status,
    record: draftFromScholar(record, status, similarity, false, now),
    ...(abstract ? { abstract } : {}),
  };
}

function verifyOfficialUrl(
  candidate: Candidate,
  url: string,
  context: VerifyContext,
  now: Date,
): VerificationResult {
  const decision = classifyHost(url, candidate.type, context.domains);
  if (decision.tier === "indexing") return { status: "UNVERIFIED", reason: "indexing_only" };
  if (decision.tier === "type_not_allowed")
    return { status: "UNVERIFIED", reason: "type_not_primary" };
  if (decision.tier === "none") return { status: "UNVERIFIED", reason: "not_official_domain" };
  const record: RecordDraft = compact({
    type: candidate.type as EvidenceType,
    title: candidate.title,
    authors: candidate.firstAuthor ? [{ family: candidate.firstAuthor }] : [],
    year: candidate.year,
    url,
    language: candidate.language,
    verification: {
      method: "official_domain" as const,
      metadataMatch: 1,
      retracted: false,
      checkedAt: now.toISOString(),
    },
    status: "VERIFIED_PRIMARY" as const,
  }) as RecordDraft;
  return { status: "VERIFIED_PRIMARY", record };
}

// ---------------------------------------------------------------------------------------------
// Auditor limits: a status may be downgraded, never upgraded
// ---------------------------------------------------------------------------------------------

/** Lower is stronger. */
export const statusRank = (status: EvidenceStatus): number => evidenceStatuses.indexOf(status);

export function isUpgrade(from: EvidenceStatus, to: EvidenceStatus): boolean {
  return statusRank(to) < statusRank(from);
}

export function applyAuditorStatus(
  assigned: EvidenceStatus,
  requested: EvidenceStatus | undefined,
): EvidenceStatus {
  if (!requested || isUpgrade(assigned, requested)) return assigned;
  return requested;
}
