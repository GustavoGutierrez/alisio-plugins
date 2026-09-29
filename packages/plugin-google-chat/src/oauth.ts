import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_ORIGIN, type OAuthConfig } from "./config.js";
import { GoogleChatError } from "./errors.js";
import { createTokenSet, type TokenSet } from "./token-set.js";
import {
  type Fetcher,
  MAX_RETRY_AFTER_SECONDS,
  rawRequest,
  retryAfterSeconds,
} from "./transport.js";

/**
 * OAuth 2.0 authorization-code flow with PKCE for a local Node process.
 *
 * The device authorization grant does not allow `chat.*` scopes, and the
 * out-of-band copy/paste flow is deprecated, so the only supported flow is a
 * loopback redirect registered on a "Desktop app" OAuth client
 * (`http://127.0.0.1:{port}`). The client secret is present at token exchange.
 */

/** A random PKCE code verifier (43-128 unreserved characters). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** S256 PKCE challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** An unguessable `state` value bound to one authorization attempt. */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export interface AuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}

/** Build the browser authorization URL. The plugin never fetches this URL. */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate a loopback callback request URL and return the authorization code.
 * A denied request, an absent or mismatched `state`, or a missing code is
 * refused. The error text never echoes the code, the state, or the raw URL.
 */
export function parseCallbackUrl(requestUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    throw new GoogleChatError("invalid response", "malformed authorization callback");
  }
  if (url.searchParams.get("error") !== null)
    throw new GoogleChatError("not authenticated", "authorization was denied or failed");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state === null || !constantTimeEqual(state, expectedState))
    throw new GoogleChatError("invalid response", "authorization state did not match");
  if (code === null || code === "")
    throw new GoogleChatError("invalid response", "authorization code was absent");
  return code;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  expiresIn: number | undefined;
  scopes: string[];
  tokenType: string;
}

function parseTokenResponse(raw: unknown): TokenResponse {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken === "")
    throw new GoogleChatError("invalid response", "the token endpoint returned no access token");
  const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token : undefined;
  const expiresIn =
    typeof value.expires_in === "number"
      ? value.expires_in
      : typeof value.expires_in === "string" && /^[0-9]{1,9}$/.test(value.expires_in)
        ? Number.parseInt(value.expires_in, 10)
        : undefined;
  const scopes =
    typeof value.scope === "string"
      ? value.scope
          .split(/\s+/)
          .map((scope) => scope.trim())
          .filter((scope) => scope !== "")
      : [];
  return {
    accessToken,
    refreshToken,
    expiresIn,
    scopes,
    tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
  };
}

function mapTokenFailure(
  response: { status: number; headers: Headers; text: string },
  now: number,
): GoogleChatError {
  const retry = retryAfterSeconds(response.headers, now, MAX_RETRY_AFTER_SECONDS);
  const detail = retry === undefined ? undefined : `retry after ${retry} seconds`;
  if (response.status === 429) return new GoogleChatError("rate limited", detail);
  if (response.status >= 500) return new GoogleChatError("temporarily unavailable", detail);
  let error = "";
  try {
    const parsed = JSON.parse(response.text) as Record<string, unknown>;
    error = typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    // The body is not JSON; fall through to the generic classification.
  }
  if (error === "invalid_grant")
    return new GoogleChatError(
      "not authenticated",
      "the stored Google authorization was revoked or expired; run google-chat-auth again",
    );
  if (response.status === 400 || response.status === 401)
    return new GoogleChatError(
      "not authenticated",
      "the Google authorization request was rejected; check the OAuth client and scopes",
    );
  return new GoogleChatError("invalid response");
}

async function tokenRequest(
  body: URLSearchParams,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const response = await rawRequest({
    fetcher,
    method: "POST",
    url: `${OAUTH_TOKEN_ORIGIN}/token`,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal,
    origin: OAUTH_TOKEN_ORIGIN,
  });
  if (response.status < 200 || response.status >= 300) throw mapTokenFailure(response, Date.now());
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new GoogleChatError("invalid response", "the token endpoint returned a non-JSON body");
  }
  return parseTokenResponse(parsed);
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeAuthorizationCode(input: {
  config: OAuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetcher: Fetcher;
  signal: AbortSignal;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  return tokenRequest(body, input.fetcher, input.signal);
}

/** Exchange a refresh token for a fresh access token. */
export function refreshAccessToken(input: {
  config: OAuthConfig;
  refreshToken: string;
  fetcher: Fetcher;
  signal: AbortSignal;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  return tokenRequest(body, input.fetcher, input.signal);
}

export interface LoopbackOptions {
  config: OAuthConfig;
  fetcher: Fetcher;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Called once with the browser URL, before the plugin blocks on the callback. */
  onAuthorizationUrl?: ((url: string) => void) | undefined;
  /** Test seam: keep the process alive alongside the callback wait. */
  onListening?: ((port: number) => void) | undefined;
}

export interface LoopbackResult {
  authorizationUrl: string;
  token: TokenSet;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    try {
      server.closeAllConnections?.();
      server.close(() => finish());
    } catch {
      finish();
    }
  });
}

/**
 * Run the loopback authorization flow end to end: bind `127.0.0.1` on an
 * ephemeral port, surface the authorization URL, wait (bounded) for the
 * callback, validate the state, exchange the code with PKCE, and always close
 * the listener. Returns the tokens to the caller for atomic persistence; the
 * code, tokens, and secret are never returned in an error or a log.
 */
export async function runLoopbackAuthorization(options: LoopbackOptions): Promise<LoopbackResult> {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeS256(verifier);
  const state = generateState();
  const server = createServer();
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Mark the rejection handled while the listener binds so a fast timeout can
  // never surface as an unhandled rejection; the `await` below still sees it.
  void codePromise.catch(() => undefined);
  const settle = (error: unknown, code?: string): void => {
    if (settled) return;
    settled = true;
    if (error !== undefined && error !== null) rejectCode(error);
    else resolveCode(code as string);
  };

  server.on("request", (request, response) => {
    const address = server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    if ((request.headers.host ?? "") !== expectedHost) {
      response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      response.end("Unexpected host.\n");
      return;
    }
    if (request.method !== "GET" || (request.url ?? "/").split("?")[0] !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
      return;
    }
    const requestUrl = request.url ?? "/";
    const attempt = new URL(requestUrl, "http://127.0.0.1");
    const isCallback =
      attempt.searchParams.has("code") ||
      attempt.searchParams.has("state") ||
      attempt.searchParams.has("error");
    if (!isCallback) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Waiting for the Google authorization redirect.\n");
      return;
    }
    try {
      const code = parseCallbackUrl(requestUrl, state);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization received. You can close this tab and return to Alisio.\n");
      settle(undefined, code);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization failed. Return to Alisio for details.\n");
      settle(error);
    }
  });

  const timer = setTimeout(() => {
    settle(
      new GoogleChatError(
        "not authenticated",
        "the authorization flow timed out; run google-chat-auth again",
      ),
    );
  }, options.timeoutMs);

  const onAbort = (): void => {
    settle(new GoogleChatError("not authenticated", "authorization was cancelled"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address !== "object")
      throw new GoogleChatError("invalid response", "could not bind the loopback listener");
    const redirectUri = `http://127.0.0.1:${address.port}`;
    options.onListening?.(address.port);
    const authorizationUrl = buildAuthorizationUrl({
      clientId: options.config.clientId,
      redirectUri,
      scopes: options.config.scopes,
      state,
      codeChallenge: challenge,
    });
    options.onAuthorizationUrl?.(authorizationUrl);
    const code = await codePromise;
    const response = await exchangeAuthorizationCode({
      config: options.config,
      code,
      codeVerifier: verifier,
      redirectUri,
      fetcher: options.fetcher,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs),
    });
    const token = createTokenSet({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiry: response.expiresIn === undefined ? undefined : Date.now() + response.expiresIn * 1000,
      scopes: response.scopes.length > 0 ? response.scopes : options.config.scopes,
      tokenType: response.tokenType,
    });
    return { authorizationUrl, token };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await closeServer(server);
  }
}
