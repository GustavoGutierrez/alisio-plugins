import { GoogleChatError } from "./errors.js";

/**
 * An OAuth token set. The access and refresh tokens are attached as
 * non-enumerable properties, so `JSON.stringify` and `util.inspect` never reveal
 * them. Only `serializeTokenSet` writes them, and only into the plugin-owned
 * `0600` token file.
 */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiry: number | undefined;
  readonly scopes: readonly string[];
  readonly tokenType: string;
}

export function createTokenSet(input: {
  accessToken: string;
  refreshToken: string | undefined;
  expiry: number | undefined;
  scopes: readonly string[];
  tokenType: string;
}): TokenSet {
  const token = {} as TokenSet;
  Object.defineProperties(token, {
    accessToken: {
      value: input.accessToken,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    refreshToken: {
      value: input.refreshToken,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    expiry: { value: input.expiry, enumerable: true, writable: false, configurable: false },
    scopes: {
      value: Object.freeze([...input.scopes]),
      enumerable: true,
      writable: false,
      configurable: false,
    },
    tokenType: { value: input.tokenType, enumerable: true, writable: false, configurable: false },
  });
  return Object.freeze(token) as TokenSet;
}

/** Serialize for disk. This is the only place token material is written out. */
export function serializeTokenSet(token: TokenSet): string {
  const record: Record<string, unknown> = {
    version: 1,
    accessToken: token.accessToken,
    expiry: token.expiry ?? null,
    scopes: [...token.scopes],
    tokenType: token.tokenType,
  };
  if (token.refreshToken !== undefined) record.refreshToken = token.refreshToken;
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Validate a parsed token file. Never echoes any value on failure. */
export function parseTokenSet(raw: unknown): TokenSet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new GoogleChatError(
      "configuration missing or invalid",
      "the stored Google Chat token file is malformed; delete it and run google-chat-auth again",
    );
  const value = raw as Record<string, unknown>;
  const accessToken = value.accessToken;
  if (typeof accessToken !== "string" || accessToken === "")
    throw new GoogleChatError(
      "configuration missing or invalid",
      "the stored Google Chat token file has no access token; run google-chat-auth again",
    );
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : undefined;
  const expiry =
    typeof value.expiry === "number" && Number.isFinite(value.expiry) ? value.expiry : undefined;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const tokenType = typeof value.tokenType === "string" ? value.tokenType : "Bearer";
  return createTokenSet({ accessToken, refreshToken, expiry, scopes, tokenType });
}

export function isExpired(token: TokenSet, now: number, skewMs: number): boolean {
  if (token.expiry === undefined) return false;
  return now >= token.expiry - skewMs;
}
