import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SwarmServices } from "../app/services.js";
import { type DashboardAsset, loadDashboardAsset } from "../resources.js";
import { type ApiDeps, ApiError, handleApi, statusFor } from "./api.js";
import {
  generateToken,
  hostAllowed,
  originAllowed,
  parseCookies,
  TOKEN_COOKIE,
  TOKEN_HEADER,
  tokenMatches,
} from "./auth.js";

export const MAX_BODY_BYTES = 256 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TOKEN_PLACEHOLDER = "__SWARM_TOKEN__";

export interface DashboardOptions {
  services: SwarmServices;
  workspace: string;
  /** Test seam: a fixed token. Production generates a random 256-bit one. */
  token?: string;
  /** Test seam: where the static files come from. */
  assets?: (name: DashboardAsset) => Promise<string>;
  /** Called once when the server stops, however that happens. */
  onClosed?: () => void;
}

export interface DashboardHandle {
  /** The URL to open: it carries the token once, exchanged for a cookie and then dropped. */
  url: string;
  baseUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const STATIC: Record<string, { asset: DashboardAsset; type: string }> = {
  "/": { asset: "dashboard.html", type: "text/html; charset=utf-8" },
  "/dashboard.css": { asset: "dashboard.css", type: "text/css; charset=utf-8" },
  "/dashboard.js": { asset: "dashboard.js", type: "text/javascript; charset=utf-8" },
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown, extra = {}): void =>
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extra);

const fail = (res: ServerResponse, status: number, message: string, extra = {}): void =>
  sendJson(res, status, { error: message }, extra);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new ApiError(413, "The request body is too large (limit 256 KiB)"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * The dashboard server: static page plus JSON API on `127.0.0.1` (AD-9). Every request needs the
 * per-run token, a loopback `Host` and (when present) a local `Origin`; there is no CORS and the
 * CSP forbids anything but the page's own origin. Mutations call the same services as the commands.
 */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const token = options.token ?? generateToken();
  const loadAsset = options.assets ?? loadDashboardAsset;
  const deps: ApiDeps = { services: options.services, workspace: options.workspace };
  let port = 0;

  const authorised = (req: IncomingMessage, mutating: boolean): boolean => {
    const header = req.headers[TOKEN_HEADER];
    if (tokenMatches(token, Array.isArray(header) ? header[0] : header)) return true;
    if (mutating) return false;
    return tokenMatches(token, parseCookies(req.headers.cookie)[TOKEN_COOKIE]);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host, port)) return fail(res, 403, "Unexpected Host header");
    const origin = req.headers.origin;
    if (!originAllowed(Array.isArray(origin) ? origin[0] : origin, port)) {
      return fail(res, 403, "Unexpected Origin header");
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      return fail(res, 405, "Method not allowed", { allow: "GET, POST" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (!tokenMatches(token, url.searchParams.get("token") ?? undefined)) {
        return fail(res, 401, "Invalid token");
      }
      return send(res, 302, "", "text/plain; charset=utf-8", {
        location: "/",
        "set-cookie": `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      });
    }
    if (!authorised(req, method === "POST")) return fail(res, 401, "A valid token is required");

    const fixed = method === "GET" ? STATIC[url.pathname] : undefined;
    if (fixed) {
      const content = await loadAsset(fixed.asset);
      return send(res, 200, content.replaceAll(TOKEN_PLACEHOLDER, token), fixed.type);
    }
    if (!url.pathname.startsWith("/api/")) return fail(res, 404, "Not found");

    let segments: string[];
    try {
      segments = url.pathname
        .slice("/api/".length)
        .split("/")
        .map((part) => decodeURIComponent(part));
    } catch {
      return fail(res, 400, "Malformed path");
    }
    let body: unknown;
    if (method === "POST") {
      if (
        !String(req.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        return fail(res, 415, "Send application/json");
      }
      const raw = await readBody(req);
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return fail(res, 400, "The body is not valid JSON");
      }
    }
    const result = await handleApi(deps, { method, segments, query: url.searchParams, body });
    sendJson(res, result.status, result.body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Our own validation messages are safe to show; system errors (paths, codes) are not.
      const system =
        error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
      const status = system || !(error instanceof Error) ? 500 : statusFor(error);
      const message = status === 500 ? "Internal error" : (error as Error).message;
      if (error instanceof ApiError && error.status === 413) {
        fail(res, 413, message, { connection: "close" });
        res.once("finish", () => req.destroy());
        return;
      }
      fail(res, status, message);
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let closing: Promise<void> | undefined;
  let forget: () => void = () => undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      forget();
      options.onClosed?.();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  forget = options.services.onTeardown(close);
  return { url: `${baseUrl}/?token=${token}`, baseUrl, port, token, close };
}
