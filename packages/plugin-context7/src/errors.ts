/**
 * Centralized failure vocabulary. Every failure this plugin exposes to a caller is
 * exactly one of these strings, optionally decorated with a bounded retry hint, and
 * never a URL, header, request body, session id, or raw service payload.
 */
export const FAILURE_CODES = [
  "invalid input",
  "rate limited",
  "authentication failed",
  "temporarily unavailable",
  "invalid response",
  "response exceeded limit",
  "redirect refused",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** A safe, classified failure. */
export class Context7Error extends Error {
  readonly code: FailureCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: FailureCode, retryAfterSeconds?: number) {
    super(code);
    this.name = "Context7Error";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    if (code === "rate limited" && retryAfterSeconds !== undefined)
      this.message = `rate limited (retry after ${retryAfterSeconds}s)`;
  }
}

/** Coerce any thrown value into the safe vocabulary without reading its text. */
export function toContext7Error(error: unknown): Context7Error {
  return error instanceof Context7Error ? error : new Context7Error("temporarily unavailable");
}
