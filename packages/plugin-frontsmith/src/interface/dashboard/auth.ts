import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_COOKIE = "frontsmith_token";
export const TOKEN_HEADER = "x-frontsmith-token";

/** A random 256-bit token, hex encoded. One per dashboard run (spec 18.4). */
export const generateToken = (): string => randomBytes(32).toString("hex");

/** Constant-time comparison; a missing or differently sized value never matches. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const cookie = part.trim();
    const index = cookie.indexOf("=");
    if (index <= 0) continue;
    out[cookie.slice(0, index)] = cookie.slice(index + 1).trim();
  }
  return out;
}

/** The only `Host` values accepted: the loopback names with the bound port (DNS rebinding guard). */
export const allowedHosts = (port: number): Set<string> =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

export const hostAllowed = (host: string | undefined, port: number): boolean =>
  host !== undefined && allowedHosts(port).has(host.toLowerCase());

/** A missing `Origin` is fine (same-origin navigation, scripts); a present one must be ours. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return [...allowedHosts(port)].some((host) => origin === `http://${host}`);
}
