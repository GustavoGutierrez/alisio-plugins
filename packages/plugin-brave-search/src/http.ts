import { BraveSearchError } from "./errors.js";
import type { LlmContextRequest, WebSearchRequest } from "./validation.js";

/** The only origin this plugin ever contacts. */
export const API_ORIGIN = "https://api.search.brave.com";
export const LLM_CONTEXT_PATH = "/res/v1/llm/context";
export const WEB_SEARCH_PATH = "/res/v1/web/search";

/** Brave recommends a 30-second client timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on a response body; a 32k-token grounding payload is far smaller. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Retry hints above this are reported but never waited on. */
const MAX_RETRY_HINT_SECONDS = 60 * 60 * 24 * 31;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The LLM Context POST body: identical names to the documented query parameters. */
export function buildLlmContextBody(request: LlmContextRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    q: request.query,
    maximum_number_of_tokens: request.maxTokens,
  };
  if (request.count !== undefined) body.count = request.count;
  if (request.maxUrls !== undefined) body.maximum_number_of_urls = request.maxUrls;
  if (request.threshold !== undefined) body.context_threshold_mode = request.threshold;
  if (request.freshness !== undefined) body.freshness = request.freshness;
  if (request.country !== undefined) body.country = request.country;
  if (request.searchLang !== undefined) body.search_lang = request.searchLang;
  if (request.goggles !== undefined) body.goggles = request.goggles;
  return body;
}

/** The Web Search GET URL; decorations off and web results only to keep payloads small. */
export function buildWebSearchUrl(request: WebSearchRequest): URL {
  const url = new URL(WEB_SEARCH_PATH, API_ORIGIN);
  url.searchParams.set("q", request.query);
  url.searchParams.set("count", String(request.count));
  if (request.offset !== undefined) url.searchParams.set("offset", String(request.offset));
  if (request.freshness !== undefined) url.searchParams.set("freshness", request.freshness);
  if (request.country !== undefined) url.searchParams.set("country", request.country);
  if (request.searchLang !== undefined) url.searchParams.set("search_lang", request.searchLang);
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("result_filter", "web");
  return url;
}

function parseSecondsList(raw: string | null): number[] | undefined {
  if (raw === null) return undefined;
  const values = raw.split(",").map((part) => part.trim());
  if (values.length === 0 || values.some((value) => !/^\d{1,10}$/.test(value))) return undefined;
  return values.map(Number);
}

/**
 * Seconds until a retry is sensible. `Retry-After` (seconds) wins when present;
 * otherwise Brave's `X-RateLimit-Reset` list is read at the first window whose
 * `X-RateLimit-Remaining` is zero, falling back to the first window.
 */
export function rateLimitRetrySeconds(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && /^\d{1,10}$/.test(retryAfter))
    return Math.min(Number(retryAfter), MAX_RETRY_HINT_SECONDS);
  const reset = parseSecondsList(headers.get("x-ratelimit-reset"));
  if (reset === undefined) return undefined;
  const remaining = parseSecondsList(headers.get("x-ratelimit-remaining"));
  const exhausted = remaining?.indexOf(0) ?? -1;
  const seconds = reset[exhausted >= 0 && exhausted < reset.length ? exhausted : 0];
  return seconds === undefined ? undefined : Math.min(seconds, MAX_RETRY_HINT_SECONDS);
}

function rateLimited(headers: Headers): BraveSearchError {
  const seconds = rateLimitRetrySeconds(headers);
  if (seconds === undefined)
    return new BraveSearchError(
      "rate limited",
      "Brave Search rejected the request (HTTP 429); wait before retrying",
    );
  const detail =
    seconds > 3_600
      ? `the plan quota appears exhausted; it resets in about ${Math.ceil(seconds / 3_600)}h (retry after ${seconds}s)`
      : `retry after ${seconds}s`;
  return new BraveSearchError("rate limited", detail, seconds);
}

function statusError(response: Response): BraveSearchError {
  const { status } = response;
  if (status >= 300 && status < 400)
    return new BraveSearchError("redirect refused", `unexpected HTTP ${status} redirect`);
  if (status === 401)
    return new BraveSearchError(
      "authentication failed",
      "Brave Search rejected the API key (HTTP 401). Check the key in the Brave Search API dashboard and run /brave-search:status",
    );
  if (status === 403)
    return new BraveSearchError(
      "not permitted",
      "the API key is not allowed to use this endpoint (HTTP 403). Confirm your Brave Search API subscription includes it",
    );
  if (status === 429) return rateLimited(response.headers);
  if (status === 400 || status === 422)
    return new BraveSearchError(
      "request rejected",
      `Brave Search rejected the request parameters (HTTP ${status}). Use a shorter query (max 400 characters, 50 words) and documented option values`,
    );
  return new BraveSearchError("temporarily unavailable", `Brave Search returned HTTP ${status}`);
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES)
    throw new BraveSearchError("response exceeded limit");
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BraveSearchError("response exceeded limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface RequestOptions {
  url: URL;
  method: "GET" | "POST";
  apiKey: string;
  body?: Record<string, unknown>;
  /** Caller cancellation (the host tool signal). */
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * One bounded request to the fixed Brave origin. No retries, no redirects, no
 * cookies; the body is size-capped and parsed as JSON. Failures are classified
 * into the closed vocabulary and never carry the response body or the key.
 */
export async function requestJson(fetcher: Fetcher, options: RequestOptions): Promise<unknown> {
  if (options.url.origin !== API_ORIGIN)
    throw new BraveSearchError("invalid input", "refusing a non-Brave destination");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-subscription-token": options.apiKey,
  };
  const init: RequestInit = {
    method: options.method,
    headers,
    redirect: "manual",
    credentials: "omit",
    signal,
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetcher(options.url.toString(), init);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response);
    }
    text = await readBounded(response);
  } catch (error) {
    if (error instanceof BraveSearchError) throw error;
    if (options.signal.aborted)
      throw new BraveSearchError("cancelled", "the request was cancelled");
    if (timeout.aborted)
      throw new BraveSearchError(
        "timed out",
        `Brave Search did not answer within ${Math.round((options.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)}s`,
      );
    throw new BraveSearchError("temporarily unavailable", "Brave Search could not be reached");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BraveSearchError("invalid response", "Brave Search returned a non-JSON body");
  }
}
