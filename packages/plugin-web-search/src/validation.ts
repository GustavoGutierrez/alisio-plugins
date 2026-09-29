import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const PROVIDERS = [
  "exaMcp",
  "searxng",
  "brave",
  "tavily",
  "jina",
  "firecrawl",
  "exaApi",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type SearchInput = {
  query: string;
  maxResults: number;
  language?: string | undefined;
  country?: string | undefined;
  safeSearch?: boolean | undefined;
  freshness?: string | undefined;
  includeDomains: string[];
  excludeDomains: string[];
  provider?: ProviderId | undefined;
};
export type SearchItem = {
  title: string;
  url: string;
  snippet?: string | undefined;
  date?: string | undefined;
  score?: number | undefined;
  siteName?: string | undefined;
  provider: ProviderId;
};

const bounded = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value.trim() : undefined;
const domainList = (value: unknown, label: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30)
    throw new Error(`${label} must contain at most 30 domains`);
  return value.map((item) => {
    const domain = bounded(item, 253)?.toLowerCase();
    if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
      throw new Error(`${label} contains an invalid domain`);
    return domain;
  });
};
export function parseSearchInput(value: Record<string, unknown>): SearchInput {
  const query = bounded(value.query, 512);
  if (!query || query.length < 1) throw new Error("query must be 1 to 512 characters");
  const maxResults = value.maxResults === undefined ? 5 : value.maxResults;
  if (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 20)
    throw new Error("maxResults must be an integer from 1 to 20");
  const provider = value.provider;
  if (provider !== undefined && !PROVIDERS.includes(provider as ProviderId))
    throw new Error("provider is not supported");
  const language = value.language === undefined ? undefined : bounded(value.language, 35);
  const country =
    value.country === undefined ? undefined : bounded(value.country, 3)?.toUpperCase();
  const freshness = value.freshness === undefined ? undefined : bounded(value.freshness, 32);
  if (
    (value.language !== undefined && !language) ||
    (value.country !== undefined && !/^[A-Z]{2}$/.test(country ?? "")) ||
    (value.freshness !== undefined && !freshness)
  )
    throw new Error("a search filter is invalid");
  if (value.safeSearch !== undefined && typeof value.safeSearch !== "boolean")
    throw new Error("safeSearch must be a boolean");
  return {
    query,
    maxResults: maxResults as number,
    language,
    country,
    safeSearch: value.safeSearch as boolean | undefined,
    freshness,
    includeDomains: domainList(value.includeDomains, "includeDomains"),
    excludeDomains: domainList(value.excludeDomains, "excludeDomains"),
    provider: provider as ProviderId | undefined,
  };
}

const unsafeV4 = (ip: string) =>
  /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|198\.(1[89]|5[01])|2(?:2[4-9]|3\d)|240)\./.test(
    ip,
  );
const unsafeV6 = (ip: string) => ip === "::1" || /^(?:fc|fd|fe[89ab]|ff)/i.test(ip) || ip === "::";
export function assertPublicAddress(address: string) {
  if ((isIP(address) === 4 && unsafeV4(address)) || (isIP(address) === 6 && unsafeV6(address)))
    throw new Error("URL resolves to a non-public address");
}
export function parsePublicUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is invalid");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || !url.hostname)
    throw new Error("URL is not an allowed public HTTP URL");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
    throw new Error("URL is not public");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) assertPublicAddress(host);
  return url;
}
export function parseSearxngOrigin(value: unknown): URL {
  if (typeof value !== "string") throw new Error("searxngUrl is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("searxngUrl is invalid");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("searxngUrl must be HTTPS, or HTTP loopback");
  return url;
}
export async function assertPublicUrl(
  value: unknown,
  resolve: typeof lookup = lookup,
): Promise<URL> {
  const url = parsePublicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    const records = await resolve(host, { all: true, verbatim: true });
    if (!records.length) throw new Error("URL has no public address");
    for (const record of records) assertPublicAddress(record.address);
  }
  return url;
}
export function cleanText(value: unknown, maximum = 2000) {
  return typeof value === "string"
    ? [...value]
        .map((character) => ((character.codePointAt(0) ?? 32) < 32 ? " " : character))
        .join("")
        .trim()
        .slice(0, maximum)
    : undefined;
}
export function item(value: Record<string, unknown>, provider: ProviderId): SearchItem | undefined {
  try {
    const url = parsePublicUrl(value.url).toString();
    const title = cleanText(value.title, 300);
    if (!title) return undefined;
    const score =
      typeof value.score === "number" && Number.isFinite(value.score) ? value.score : undefined;
    return {
      title,
      url,
      snippet: cleanText(value.snippet),
      date: cleanText(value.date, 80),
      score,
      siteName: cleanText(value.siteName, 160),
      provider,
    };
  } catch {
    return undefined;
  }
}
