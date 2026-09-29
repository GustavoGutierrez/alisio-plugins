import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { OAuthConfig } from "./config.js";
import { GoogleChatError } from "./errors.js";
import { refreshAccessToken } from "./oauth.js";
import type { Clock } from "./time.js";
import {
  createTokenSet,
  isExpired,
  parseTokenSet,
  serializeTokenSet,
  type TokenSet,
} from "./token-set.js";
import type { Fetcher } from "./transport.js";

export * from "./token-set.js";

/** Plugin-owned token persistence at `<configHome>/google-chat/token.json`. */
export class TokenStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): TokenSet | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new GoogleChatError(
        "configuration missing or invalid",
        "the stored Google Chat token file could not be read",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoogleChatError(
        "configuration missing or invalid",
        "the stored Google Chat token file is not valid JSON; delete it and run google-chat-auth again",
      );
    }
    return parseTokenSet(parsed);
  }

  /** Atomically write the token file with `0600`, creating parents with `0700`. */
  write(token: TokenSet): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Hardening only.
    }
    const temp = `${this.path}.${process.pid}.tmp`;
    const descriptor = openSync(temp, "w", 0o600);
    try {
      writeSync(descriptor, serializeTokenSet(token), 0, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Hardening only.
    }
    renameSync(temp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Hardening only.
    }
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Best effort; the file may already be absent.
    }
  }
}

export interface RefreshContext {
  oauth: OAuthConfig;
  fetcher: Fetcher;
  clock: Clock;
  signal: AbortSignal;
  skewMs: number;
}

/**
 * Return a usable access token, refreshing once when the stored token is
 * expired. A refresh failure that reports `invalid_grant` clears the store so
 * the operator is told to re-authorize instead of retrying a dead token.
 */
export async function obtainAccessToken(
  store: TokenStore,
  context: RefreshContext,
  options: { force?: boolean } = {},
): Promise<TokenSet> {
  const current = store.read();
  if (current === null)
    throw new GoogleChatError(
      "not authenticated",
      "no stored Google authorization; run google-chat-auth to authorize a user account",
    );
  if (options.force !== true && !isExpired(current, context.clock.now(), context.skewMs))
    return current;
  if (current.refreshToken === undefined)
    throw new GoogleChatError(
      "not authenticated",
      "the stored Google authorization expired and has no refresh token; run google-chat-auth again",
    );
  let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshed = await refreshAccessToken({
      config: context.oauth,
      refreshToken: current.refreshToken,
      fetcher: context.fetcher,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof GoogleChatError && error.code === "not authenticated") {
      try {
        store.clear();
      } catch {
        // Clearing is best effort; the original error is what matters.
      }
    }
    throw error;
  }
  const next = createTokenSet({
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
    expiry:
      refreshed.expiresIn === undefined
        ? current.expiry
        : context.clock.now() + refreshed.expiresIn * 1000,
    scopes: refreshed.scopes.length > 0 ? refreshed.scopes : current.scopes,
    tokenType: refreshed.tokenType,
  });
  store.write(next);
  return next;
}
