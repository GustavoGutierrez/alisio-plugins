const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Returns `value` only when it is a short, plain error code that cannot carry a secret. */
export const safeCode = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_CODE.test(value) && !value.startsWith("eyJ")
    ? value
    : undefined;

export const SIGN_IN_AGAIN =
  "ChatGPT sign-in expired or was revoked: sign in again from /connect (Settings > Models)";

/**
 * Plugin error with a fixed, secret-free message. `retryable: true` tells the host that a
 * `refresh()` failure is transient (spec 025 §5.1); any other rejection is permanent.
 */
export class ChatGPTError extends Error {
  readonly retryable?: true;
  readonly code?: string;
  constructor(message: string, options: { retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = "ChatGPTError";
    if (options.retryable) this.retryable = true;
    if (options.code) this.code = options.code;
  }
}

export const signInAgain = (code?: string) =>
  new ChatGPTError(code ? `${SIGN_IN_AGAIN} (${code})` : SIGN_IN_AGAIN, {
    code: "OAUTH_SIGN_IN_REQUIRED",
  });
