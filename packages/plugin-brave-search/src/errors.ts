/**
 * Closed failure vocabulary. Every failure this plugin exposes is one of these
 * codes plus an optional, plugin-authored actionable detail. Raw service bodies,
 * headers, and URLs are never surfaced, and every outgoing message is redacted
 * against the active API key as a last line of defense.
 */
export const FAILURE_CODES = [
  "invalid input",
  "missing api key",
  "authentication failed",
  "not permitted",
  "request rejected",
  "rate limited",
  "temporarily unavailable",
  "timed out",
  "cancelled",
  "invalid response",
  "response exceeded limit",
  "redirect refused",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export class BraveSearchError extends Error {
  readonly code: FailureCode;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: FailureCode, detail?: string, retryAfterSeconds?: number) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "BraveSearchError";
    this.code = code;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Coerce any thrown value into the safe vocabulary without reading its text. */
export function toBraveSearchError(error: unknown): BraveSearchError {
  return error instanceof BraveSearchError
    ? error
    : new BraveSearchError("temporarily unavailable", "the request could not be completed");
}

export const REDACTED = "[redacted]";

/** Replace every occurrence of each non-empty secret with a fixed marker. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret === "") continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
