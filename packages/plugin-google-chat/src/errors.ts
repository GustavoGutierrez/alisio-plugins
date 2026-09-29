/**
 * Closed failure vocabulary for every network and validation outcome. Callers only
 * ever see these strings (optionally with a bounded, secret-free suffix), never a
 * URL, header, request body, access token, refresh token, authorization code,
 * client secret, or raw upstream payload.
 */
export const FAILURE_CODES = [
  "invalid input",
  "not authenticated",
  "not permitted",
  "not found",
  "rate limited",
  "temporarily unavailable",
  "invalid response",
  "response exceeded limit",
  "configuration missing or invalid",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** A classified failure whose message is safe to show to a user. */
export class GoogleChatError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GoogleChatError";
    this.code = code;
  }
}

const RETRYABLE = /^(rate limited|temporarily unavailable)$/;

/**
 * Reduce any thrown value to a stable, secret-free message. Unknown throwables
 * and aborts collapse to `temporarily unavailable` because their own text may
 * embed request details.
 */
export function safeMessage(error: unknown): string {
  if (error instanceof GoogleChatError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return "temporarily unavailable";
  return "temporarily unavailable";
}

/** True when the classified code is safe to retry after a delay. */
export function isRetryableCode(code: FailureCode): boolean {
  return RETRYABLE.test(code);
}
