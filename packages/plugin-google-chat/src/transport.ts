import { GoogleChatError } from "./errors.js";

/** Transport seam for tests and embedders; defaults to the global `fetch`. */
export type Fetcher = typeof fetch;

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RETRY_AFTER_SECONDS = 3600;

export interface RawRequest {
  fetcher: Fetcher;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** The single origin this request is allowed to reach. */
  origin: string;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  redirected: boolean;
  url: string;
}

/**
 * Perform one bounded HTTP request against a fixed origin. No redirects are
 * followed, no cookies, proxy, or user agent are set, the host signal is
 * combined with a hard timeout, and the body is read through a byte cap that
 * cancels the reader on overflow. The raw URL, headers, and body never appear in
 * a thrown message.
 */
export async function rawRequest(spec: RawRequest): Promise<RawResponse> {
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let response: Response;
  try {
    const init: RequestInit = {
      method: spec.method,
      redirect: "error",
      headers: spec.headers,
      signal,
    };
    if (spec.body !== undefined) init.body = spec.body;
    response = await spec.fetcher(spec.url, init);
  } catch (error) {
    if (error instanceof GoogleChatError) throw error;
    throw new GoogleChatError("temporarily unavailable");
  }

  if (response.redirected) throw new GoogleChatError("invalid response", "redirected");
  const finalUrl = response.url;
  if (finalUrl !== "") {
    let origin: string;
    try {
      origin = new URL(finalUrl).origin;
    } catch {
      throw new GoogleChatError("invalid response");
    }
    if (origin !== spec.origin)
      throw new GoogleChatError("invalid response", "unexpected destination");
  }

  return {
    status: response.status,
    headers: response.headers,
    text: await readBounded(response),
    redirected: response.redirected,
    url: finalUrl,
  };
}

/** Read a response body with a hard byte cap, cancelling the reader on overflow. */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
      throw new GoogleChatError("response exceeded limit");
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
        throw new GoogleChatError("response exceeded limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleChatError) throw error;
    throw new GoogleChatError("temporarily unavailable");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already closed or cancelled; nothing to release.
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a bounded `Retry-After` header (seconds or HTTP-date) without ever
 * sleeping on it. HTTP-dates are interpreted with the supplied current time.
 */
export function retryAfterSeconds(
  headers: Headers,
  now: number,
  maximum: number,
): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (/^[0-9]{1,10}$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds >= 0 ? Math.min(seconds, maximum) : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const seconds = Math.ceil((when - now) / 1000);
  return seconds > 0 ? Math.min(seconds, maximum) : undefined;
}
