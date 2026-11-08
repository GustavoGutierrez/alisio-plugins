import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export type RandomBytes = (size: number) => Uint8Array;

/** URL-safe random string of `size` bytes (32 bytes = 43 characters). */
export const randomToken = (random: RandomBytes, size = 32) =>
  Buffer.from(random(size)).toString("base64url");

export const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

/** PKCE S256 pair (RFC 7636). The verifier stays in the plugin. */
export function createPkce(random: RandomBytes = nodeRandomBytes) {
  const verifier = randomToken(random, 32);
  return { verifier, challenge: challengeFor(verifier) };
}

/** Constant-time string comparison. */
export function sameValue(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
