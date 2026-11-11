/**
 * Source ingestion boundary: local text files and public HTTPS pages.
 *
 * URL import guards, in order: HTTPS on port 443 only, no credentials, no IP literal or local
 * hostname; every DNS answer must be a public unicast address (IPv4 and IPv6, including mapped,
 * NAT64 and 6to4 forms); the socket connects to the validated address (DNS pinning, so a second
 * lookup cannot rebind it); each redirect is re-validated from scratch; only HTML is accepted, with
 * a byte limit, a header limit and a timeout.
 */
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Source } from "./types.js";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_URL_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12_000;
const TEXT_MIMES = ["text/plain", "text/csv", "application/json", "text/markdown", "text/html"];

export function sourceText(name: string, mime: string, base64: string): Source {
  if (base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new Error("source_too_large");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("source_too_large");
  if (!TEXT_MIMES.includes(mime)) throw new Error("unsupported_file_type");
  const raw = bytes.toString("utf8");
  const text = mime === "text/html" ? htmlToPlain(raw) : raw;
  return {
    id: randomUUID(),
    name: name.slice(0, 150),
    kind: mime === "text/csv" ? "csv" : "file",
    mime,
    text,
    importedAt: new Date().toISOString(),
  };
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv4 embedded in IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16). */
function embeddedIPv4(ipv6: string): string | null {
  const groups = expandIPv6(ipv6);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zeros(0, 5) && (groups[5] === 0xffff || groups[5] === 0))
    return v4(groups[6] ?? 0, groups[7] ?? 0);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6))
    return v4(groups[6] ?? 0, groups[7] ?? 0);
  if (groups[0] === 0x2002) return v4(groups[1] ?? 0, groups[2] ?? 0);
  return null;
}

function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const parts = dotted[1].split(".").map(Number);
    text = text.replace(
      dotted[1],
      `${(((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16)}:${(((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16)}`,
    );
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  const groups = all.map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/** True for every address that is not public unicast (and for anything that is not an IP). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const embedded = embeddedIPv4(address);
  if (embedded) return isPrivateAddress(embedded);
  return blocked.check(address, "ipv6");
}

export function htmlToPlain(input: string): string {
  return input
    .replace(/<(script|style|noscript|iframe|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:h[1-6]|p|li|section|article|tr|div|br)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;
type RequestFn = (
  url: URL,
  options: RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => {
  on(event: "timeout" | "error", listener: (error?: Error) => void): unknown;
  destroy(error?: Error): unknown;
  end(): unknown;
};

export interface UrlImportOptions {
  /** DNS resolution (all addresses). Injected in tests. */
  lookup?: LookupAll;
  /** Issues the HTTPS request. Injected in tests to reach a local server. */
  request?: RequestFn;
  maxBytes?: number;
  timeoutMs?: number;
}

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });
const defaultRequest: RequestFn = (url, options, onResponse) =>
  httpsRequest(url, options, onResponse);

interface Fetched {
  status: number;
  body: string;
  location?: string;
}

function fetchPinned(
  url: URL,
  address: { address: string; family: number },
  options: Required<Pick<UrlImportOptions, "request" | "maxBytes" | "timeoutMs">>,
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = options.request(
      url,
      {
        method: "GET",
        timeout: options.timeoutMs,
        maxHeaderSize: 16 * 1024,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Alisio-ReportForge/0.1",
        },
        // DNS pinning: the socket can only connect to the address validated above.
        lookup: ((
          _host: string,
          opts: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (opts?.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        }) as RequestOptions["lookup"],
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        const location =
          typeof res.headers.location === "string" ? res.headers.location : undefined;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (!location) reject(new Error("redirect_without_location"));
          else resolve({ status, body: "", location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`remote_http_${status}`));
          return;
        }
        if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
          res.resume();
          reject(new Error("url_not_html"));
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > options.maxBytes) {
          res.destroy();
          reject(new Error("url_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let count = 0;
        res.on("data", (chunk: Buffer) => {
          count += chunk.length;
          if (count > options.maxBytes) {
            res.destroy();
            reject(new Error("url_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("url_timeout")));
    req.on("error", (error) => reject(error ?? new Error("url_failed")));
    req.end();
  });
}

/** Rejects a URL that is not a plain public HTTPS URL. Exported for tests. */
export function checkUrlShape(u: URL): void {
  const host = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIP(host.replace(/^\[|\]$/g, "")) !== 0
  ) {
    throw new Error("unsafe_url");
  }
}

/** Fetches a public HTTPS HTML page and returns its text as a source. */
export async function importPublicUrl(
  raw: string,
  options: UrlImportOptions = {},
): Promise<Source> {
  const lookup = options.lookup ?? defaultLookup;
  const settings = {
    request: options.request ?? defaultRequest,
    maxBytes: options.maxBytes ?? MAX_URL_BYTES,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  const visited = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrlShape(u);
    if (visited.has(u.href)) throw new Error("redirect_loop");
    visited.add(u.href);
    const addresses = await lookup(u.hostname);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error("private_address_blocked");
    }
    const selected =
      addresses.find((a) => a.family === 4) ??
      (addresses[0] as { address: string; family: number });
    const data = await fetchPinned(u, selected, settings);
    if (data.location) {
      u = new URL(data.location, u);
      continue;
    }
    const text = htmlToPlain(data.body);
    if (text.length < 80) throw new Error("url_no_extractable_text");
    return {
      id: randomUUID(),
      name: (u.hostname + u.pathname).slice(0, 150),
      kind: "url",
      mime: "text/html",
      text: text.slice(0, 500_000),
      url: u.href,
      importedAt: new Date().toISOString(),
    };
  }
  throw new Error("too_many_redirects");
}
