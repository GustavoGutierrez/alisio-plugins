import { Context7Error } from "./errors.js";

/** Bounds mirrored by the public tool schemas. */
export const MAX_LIBRARY_NAME = 120;
export const MAX_QUERY = 500;
export const MAX_LIBRARY_ID = 256;

/** Minimum length accepted for a configured API key; shorter values are ignored. */
const MIN_API_KEY = 8;
const MAX_API_KEY = 512;

/** The only environment variable this plugin ever reads for authentication. */
export const API_KEY_ENV = "CONTEXT7_API_KEY";

const invalid = () => new Context7Error("invalid input");

/** A conservative token shape: printable, header-safe, no whitespace or control bytes. */
const API_KEY_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

/** One `/`-separated library id segment: starts alphanumeric or `@`, ASCII, bounded. */
const SEGMENT = /^[A-Za-z0-9@][A-Za-z0-9._~@-]*$/;

/**
 * Read and validate an optional API key. Absent, empty, or implausibly shaped values
 * resolve to `undefined` (anonymous access) and are never surfaced anywhere.
 */
export function parseApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < MIN_API_KEY || trimmed.length > MAX_API_KEY) return undefined;
  return API_KEY_SHAPE.test(trimmed) ? trimmed : undefined;
}

/** Resolve the key exclusively from the fixed environment variable. */
export function apiKeyFromEnvironment(
  environment: Record<string, string | undefined>,
): string | undefined {
  return parseApiKey(environment[API_KEY_ENV]);
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum) throw invalid();
  return trimmed;
}

export function parseLibraryName(value: unknown): string {
  return bounded(value, 1, MAX_LIBRARY_NAME);
}

export function parseQuery(value: unknown): string {
  return bounded(value, 1, MAX_QUERY);
}

/**
 * The documented Context7 library id shape: `/org/project` or `/org/project/version`.
 * It must start with `/`, contain two or three non-empty safe segments, and never
 * contain `.`/`..`, an empty segment, a query, a fragment, or a trailing slash.
 */
export function parseLibraryId(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > MAX_LIBRARY_ID) throw invalid();
  if (!trimmed.startsWith("/")) throw invalid();
  const segments = trimmed.slice(1).split("/");
  if (segments.length < 2 || segments.length > 3) throw invalid();
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !SEGMENT.test(segment)) throw invalid();
  }
  return trimmed;
}

const RESOLVE_FIELDS = ["libraryName", "query"] as const;
const QUERY_FIELDS = ["libraryId", "query"] as const;

function assertClosed(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw invalid();
}

export function parseResolveInput(input: Record<string, unknown>): {
  libraryName: string;
  query: string;
} {
  assertClosed(input, RESOLVE_FIELDS);
  return { libraryName: parseLibraryName(input.libraryName), query: parseQuery(input.query) };
}

export function parseQueryDocsInput(input: Record<string, unknown>): {
  libraryId: string;
  query: string;
} {
  assertClosed(input, QUERY_FIELDS);
  return { libraryId: parseLibraryId(input.libraryId), query: parseQuery(input.query) };
}
