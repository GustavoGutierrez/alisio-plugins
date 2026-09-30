import { BraveSearchError } from "./errors.js";

/**
 * Bounds and enumerations taken from Brave's published API documentation and the
 * input schema of Brave's official MCP server (`@brave/brave-search-mcp-server`).
 * Numeric options outside the documented ranges are clamped; everything else
 * that does not match is rejected before any network call.
 */
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_WORDS = 50;

export const TOKENS_RANGE = { min: 1_024, max: 32_768 } as const;
/** Local default budget; smaller than Brave's 8192 default to keep agent context lean. */
export const DEFAULT_MAX_TOKENS = 4_096;
export const LLM_COUNT_RANGE = { min: 1, max: 50 } as const;
export const URLS_RANGE = { min: 1, max: 50 } as const;
export const WEB_COUNT_RANGE = { min: 1, max: 20 } as const;
export const DEFAULT_WEB_COUNT = 8;
export const OFFSET_RANGE = { min: 0, max: 9 } as const;
export const MAX_GOGGLES_CHARS = 4_096;

export const THRESHOLD_MODES = ["strict", "balanced", "lenient", "disabled"] as const;
export type ThresholdMode = (typeof THRESHOLD_MODES)[number];

export const COUNTRIES = [
  "ALL",
  "AR",
  "AU",
  "AT",
  "BE",
  "BR",
  "CA",
  "CL",
  "DK",
  "FI",
  "FR",
  "DE",
  "GR",
  "HK",
  "IN",
  "ID",
  "IT",
  "JP",
  "KR",
  "MY",
  "MX",
  "NL",
  "NZ",
  "NO",
  "CN",
  "PL",
  "PT",
  "PH",
  "RU",
  "SA",
  "ZA",
  "ES",
  "SE",
  "CH",
  "TW",
  "TR",
  "GB",
  "US",
] as const;

export const SEARCH_LANGS = [
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
] as const;

export interface CommonOptions {
  freshness?: string;
  country?: string;
  searchLang?: string;
}

export interface LlmContextRequest extends CommonOptions {
  query: string;
  maxTokens: number;
  count?: number;
  maxUrls?: number;
  threshold?: ThresholdMode;
  goggles?: string;
}

export interface WebSearchRequest extends CommonOptions {
  query: string;
  count: number;
  offset?: number;
}

const invalid = (detail: string) => new BraveSearchError("invalid input", detail);

function assertClosed(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw invalid(`unknown field "${key.slice(0, 40)}"`);
}

export function parseQuery(value: unknown): string {
  if (typeof value !== "string") throw invalid("query must be a string");
  const query = value.trim();
  if (query === "") throw invalid("query must not be empty");
  if (query.length > MAX_QUERY_CHARS)
    throw invalid(`query must be at most ${MAX_QUERY_CHARS} characters`);
  if (query.split(/\s+/).length > MAX_QUERY_WORDS)
    throw invalid(`query must be at most ${MAX_QUERY_WORDS} words`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are rejected on purpose
  if (/[\u0000-\u001f\u007f]/.test(query.replace(/[\t\n]/g, " ")))
    throw invalid("query must not contain control characters");
  return query;
}

function clampedInteger(
  value: unknown,
  name: string,
  range: { min: number; max: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw invalid(`${name} must be an integer`);
  return Math.min(range.max, Math.max(range.min, value));
}

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  normalize: (raw: string) => string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  const normalized = normalize(value.trim());
  if (!(allowed as readonly string[]).includes(normalized))
    throw invalid(`${name} must be one of: ${allowed.join(", ")}`);
  return normalized as T;
}

const DATE_RANGE = /^(\d{4})-(\d{2})-(\d{2})to(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(year: string, month: string, day: string): boolean {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/** `pd`, `pw`, `pm`, `py`, or an ordered `YYYY-MM-DDtoYYYY-MM-DD` range. */
export function parseFreshness(value: unknown): string {
  if (typeof value !== "string") throw invalid("freshness must be a string");
  const trimmed = value.trim();
  if (["pd", "pw", "pm", "py"].includes(trimmed)) return trimmed;
  const match = DATE_RANGE.exec(trimmed);
  if (match) {
    const [, y1, m1, d1, y2, m2, d2] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const from = `${y1}-${m1}-${d1}`;
    const to = `${y2}-${m2}-${d2}`;
    if (isRealDate(y1, m1, d1) && isRealDate(y2, m2, d2) && from <= to) return trimmed;
  }
  throw invalid("freshness must be pd, pw, pm, py, or an ordered YYYY-MM-DDtoYYYY-MM-DD range");
}

/** A hosted goggle (`https://` URL) or an inline goggle definition. */
export function parseGoggles(value: unknown): string {
  if (typeof value !== "string") throw invalid("goggles must be a string");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_GOGGLES_CHARS)
    throw invalid(`goggles must be 1-${MAX_GOGGLES_CHARS} characters`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are rejected on purpose
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(trimmed))
    throw invalid("goggles must not contain control characters");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw invalid("goggles URL is not valid");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
      throw invalid("a hosted goggle must be an https URL without credentials");
  }
  return trimmed;
}

function commonOptions(input: Record<string, unknown>): CommonOptions {
  const options: CommonOptions = {};
  if (input.freshness !== undefined) options.freshness = parseFreshness(input.freshness);
  const country = oneOf(input.country, "country", COUNTRIES, (raw) => raw.toUpperCase());
  if (country !== undefined) options.country = country;
  const searchLang = oneOf(input.searchLang, "searchLang", SEARCH_LANGS, (raw) =>
    raw.toLowerCase(),
  );
  if (searchLang !== undefined) options.searchLang = searchLang;
  return options;
}

const LLM_FIELDS = [
  "query",
  "maxTokens",
  "count",
  "maxUrls",
  "threshold",
  "freshness",
  "country",
  "searchLang",
  "goggles",
] as const;

export function parseLlmContextInput(input: Record<string, unknown>): LlmContextRequest {
  assertClosed(input, LLM_FIELDS);
  const request: LlmContextRequest = {
    query: parseQuery(input.query),
    maxTokens: clampedInteger(input.maxTokens, "maxTokens", TOKENS_RANGE) ?? DEFAULT_MAX_TOKENS,
  };
  const count = clampedInteger(input.count, "count", LLM_COUNT_RANGE);
  if (count !== undefined) request.count = count;
  const maxUrls = clampedInteger(input.maxUrls, "maxUrls", URLS_RANGE);
  if (maxUrls !== undefined) request.maxUrls = maxUrls;
  const threshold = oneOf(input.threshold, "threshold", THRESHOLD_MODES, (raw) =>
    raw.toLowerCase(),
  );
  if (threshold !== undefined) request.threshold = threshold;
  if (input.goggles !== undefined) request.goggles = parseGoggles(input.goggles);
  return { ...request, ...commonOptions(input) };
}

const WEB_FIELDS = ["query", "count", "offset", "freshness", "country", "searchLang"] as const;

export function parseWebSearchInput(input: Record<string, unknown>): WebSearchRequest {
  assertClosed(input, WEB_FIELDS);
  const request: WebSearchRequest = {
    query: parseQuery(input.query),
    count: clampedInteger(input.count, "count", WEB_COUNT_RANGE) ?? DEFAULT_WEB_COUNT,
  };
  const offset = clampedInteger(input.offset, "offset", OFFSET_RANGE);
  if (offset !== undefined) request.offset = offset;
  return { ...request, ...commonOptions(input) };
}
