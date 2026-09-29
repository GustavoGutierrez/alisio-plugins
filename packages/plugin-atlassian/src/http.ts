import type { AtlassianConfig } from "./config.js";
import { AtlassianError } from "./errors.js";

export type Fetcher = typeof fetch;

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RETRY_AFTER_SECONDS = 3600;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface AtlassianClient {
  readonly config: AtlassianConfig;
  readonly fetcher: Fetcher;
  readonly clock: Clock;
}

export function createClient(
  config: AtlassianConfig,
  fetcher: Fetcher = fetch,
  clock: Clock = systemClock,
): AtlassianClient {
  return { config, fetcher, clock };
}

/**
 * Every request path is built from this frozen allowlist. Tools pass identifiers
 * through `buildPath`, which URL-encodes each parameter, so input can never
 * select a host, scheme, port, or arbitrary path.
 */
export const ROUTES = [
  "/rest/api/3/issue",
  "/rest/api/3/issue/{key}",
  "/rest/api/3/issue/{key}/comment",
  "/rest/api/3/issue/{key}/worklog",
  "/rest/api/3/issue/{key}/transitions",
  "/rest/api/3/issueLink",
  "/rest/api/3/search/jql",
  "/rest/api/3/project/search",
  "/rest/api/3/project/{key}/versions",
  "/rest/api/3/field",
  "/rest/api/3/user",
  "/rest/agile/1.0/board",
  "/rest/agile/1.0/board/{id}/sprint",
  "/rest/agile/1.0/board/{id}/backlog",
  "/rest/agile/1.0/board/{id}/epic",
  "/rest/agile/1.0/sprint/{id}/issue",
  "/rest/agile/1.0/backlog/issue",
  "/rest/agile/1.0/epic/{key}/issue",
  "/wiki/api/v2/pages",
  "/wiki/api/v2/pages/{id}",
  "/wiki/api/v2/pages/{id}/labels",
  "/wiki/api/v2/pages/{id}/footer-comments",
  "/wiki/api/v2/footer-comments",
  "/wiki/api/v2/spaces",
] as const;

export type RouteTemplate = (typeof ROUTES)[number];

const ROUTE_SET: ReadonlySet<string> = new Set(ROUTES);
const PLACEHOLDER = /\{([a-z]+)\}/gi;

/** Substitute URL-encoded identifiers into an allowlisted path template. */
export function buildPath(
  template: RouteTemplate,
  params: Record<string, string | number> = {},
): string {
  if (!ROUTE_SET.has(template)) throw new AtlassianError("invalid input", "unsupported path");
  const path = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new AtlassianError("invalid input", "missing path parameter");
    return encodeURIComponent(String(value));
  });
  if (path.includes("{") || path.includes("}"))
    throw new AtlassianError("invalid input", "unresolved path parameter");
  return path;
}

export type QueryValue = string | number | boolean | undefined | null;

/** Build an encoded query string from primitive values only. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (!/^[a-z0-9-]+$/i.test(key)) throw new AtlassianError("invalid input", "invalid query key");
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** HTTP Basic built from the configured email and token, at call time only. */
export function authorizationHeader(config: AtlassianConfig): string {
  const encoded = Buffer.from(`${config.email}:${config.apiToken}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

export interface RequestSpec {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal: AbortSignal;
}

/**
 * Perform one request against the fixed configured origin. No redirects, no
 * cookies, no proxy, and no headers beyond accept/authorization/content-type.
 * The host signal is combined with a bounded timeout and the response is read
 * through a hard byte cap.
 */
export async function requestJson(client: AtlassianClient, spec: RequestSpec): Promise<unknown> {
  const url = `${client.config.baseUrl}${spec.path}${buildQuery(spec.query ?? {})}`;
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: authorizationHeader(client.config),
  };
  if (spec.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    const init: RequestInit = {
      method: spec.method,
      redirect: "error",
      headers,
      signal,
    };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
    response = await client.fetcher(url, init);
  } catch (error) {
    if (error instanceof AtlassianError) throw error;
    throw new AtlassianError("temporarily unavailable");
  }

  verifyDestination(client, response);
  return readResponse(client, response);
}

/** Reject a redirect or a response that did not come from the configured origin. */
function verifyDestination(client: AtlassianClient, response: Response): void {
  if (response.redirected) throw new AtlassianError("invalid response", "redirected");
  const finalUrl = response.url;
  if (finalUrl === "") return;
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new AtlassianError("invalid response");
  }
  if (parsed.origin !== client.config.baseUrl)
    throw new AtlassianError("invalid response", "unexpected destination");
}

async function readResponse(client: AtlassianClient, response: Response): Promise<unknown> {
  const status = response.status;
  if (status >= 200 && status < 300) {
    if (status === 204 || status === 205) return {};
    const text = await readBounded(response);
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AtlassianError("invalid response");
    }
  }

  const retry = retryAfterSeconds(client, response.headers);
  const retryDetail = retry === undefined ? undefined : `retry after ${retry} seconds`;
  if (status === 401) throw new AtlassianError("not authenticated");
  if (status === 403) throw new AtlassianError("not permitted");
  if (status === 404) throw new AtlassianError("not found");
  if (status === 409)
    throw new AtlassianError("version conflict", "the target changed; re-read it and retry");
  if (status === 429) throw new AtlassianError("rate limited", retryDetail);
  if (status >= 500) throw new AtlassianError("temporarily unavailable", retryDetail);
  if (status === 400) throw new AtlassianError("invalid input");
  throw new AtlassianError("invalid response");
}

/** Read the response body with a hard byte cap, cancelling on overflow. */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw new AtlassianError("response exceeded limit");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AtlassianError("response exceeded limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AtlassianError) throw error;
    throw new AtlassianError("temporarily unavailable");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already closed or cancelled; nothing to release.
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a bounded Retry-After header without ever sleeping on it. */
function retryAfterSeconds(client: AtlassianClient, headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (/^[0-9]{1,10}$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds >= 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const seconds = Math.ceil((when - client.clock.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
}
