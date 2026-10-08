import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RenderedImage } from "../renderers/index.js";

/**
 * Optional Node HTTP adapter for the standalone renderer (spec §15).
 *
 * The host application owns authentication, data loading and the design spec; it implements
 * {@link CardEndpoint} and returns an already-rendered image or an HTTP error. This module only
 * projects that decision onto a Node request/response pair: no framework, no routing table and
 * no query-parameter surface. Cards carry private data, so the default cache policy is private
 * and the adapter never sends `public` on its own.
 */

export interface CardEndpointRequest {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
}

export type CardEndpointResult =
  | { status: "ok"; rendered: RenderedImage; cacheControl?: string }
  | { status: "forbidden" }
  | { status: "not-found" }
  | { status: "bad-request"; message: string };

export interface CardEndpoint {
  /** Host app: authenticate, load data, and return a validated render or an HTTP error code. */
  handle(request: CardEndpointRequest): Promise<CardEndpointResult>;
}

/** Default cache policy for card responses; private because the underlying data is. */
export const DEFAULT_CARD_CACHE_CONTROL = "private, max-age=60";

function etagFor(bytes: Uint8Array): string {
  return `W/"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"`;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const candidates = header.split(",").map((entry) => entry.trim());
  return candidates.includes("*") || candidates.includes(etag);
}

function textBody(message: string): Buffer {
  return Buffer.from(message, "utf8");
}

function sendText(
  res: ServerResponse,
  status: number,
  method: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = textBody(message);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.byteLength,
    ...extraHeaders,
  });
  res.end(method === "HEAD" ? undefined : body);
}

function sendInternalError(res: ServerResponse, method: string): void {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendText(res, 500, method, "Internal Server Error");
  } catch {
    res.destroy();
  }
}

/**
 * Build a `node:http` request handler over a {@link CardEndpoint}. GET and HEAD are the only
 * accepted methods (405 with `Allow` otherwise). A successful render answers 200 with
 * `Content-Type`, `ETag` (`W/"<sha256[0..16]>"`), `Cache-Control` and `Content-Length`; a matching
 * `If-None-Match` answers 304 with the same `ETag`; HEAD sends headers only. The handler never
 * rejects: an unexpected failure falls back to a 500 response.
 */
export function createCardRequestHandler(
  endpoint: CardEndpoint,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method ?? "GET";
    try {
      if (method !== "GET" && method !== "HEAD") {
        sendText(res, 405, method, "Method Not Allowed", { Allow: "GET, HEAD" });
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        sendText(res, 400, method, "Invalid request URL");
        return;
      }
      const result = await endpoint.handle({ method, url, headers: req.headers });
      switch (result.status) {
        case "ok": {
          const body = Buffer.from(result.rendered.bytes);
          const etag = etagFor(result.rendered.bytes);
          const cacheControl = result.cacheControl ?? DEFAULT_CARD_CACHE_CONTROL;
          if (ifNoneMatchMatches(headerValue(req.headers, "if-none-match"), etag)) {
            res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": result.rendered.mimeType,
            "Content-Length": body.byteLength,
            ETag: etag,
            "Cache-Control": cacheControl,
          });
          res.end(method === "HEAD" ? undefined : body);
          return;
        }
        case "forbidden":
          sendText(res, 403, method, "Forbidden");
          return;
        case "not-found":
          sendText(res, 404, method, "Not Found");
          return;
        case "bad-request":
          sendText(res, 400, method, result.message);
          return;
        default:
          sendText(res, 500, method, "Internal Server Error");
          return;
      }
    } catch {
      sendInternalError(res, method);
    }
  };
}
