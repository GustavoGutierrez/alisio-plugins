import type { ProviderOAuthCredential } from "@alisio/sdk";
import { RESOURCE, TOKEN_URL } from "./constants.js";
import { ChatGPTError, safeCode, signInAgain } from "./errors.js";

export interface TokenDeps {
  fetch: typeof fetch;
  now: () => number;
}

interface TokenSet {
  access: string;
  refresh?: string;
  expires: number;
  earliestRefreshAt?: string;
}

const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_EXPIRES_IN = 366 * 24 * 3600;
const MAX_BODY = 65_536;

const invalid = (retryable = false) =>
  new ChatGPTError("ChatGPT returned an invalid token response", { retryable });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const seconds = (value: unknown) => {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Strictly validates an OAuth token response; never echoes its content. */
export function parseTokenResponse(
  body: unknown,
  now: number,
  options: { requireRefresh: boolean; retryable?: boolean },
): TokenSet {
  const fail = () => invalid(options.retryable);
  if (!isRecord(body)) throw fail();
  const { access_token: access, refresh_token: refresh, token_type: type } = body;
  if (typeof access !== "string" || !TOKEN.test(access)) throw fail();
  if (refresh !== undefined && (typeof refresh !== "string" || !TOKEN.test(refresh))) throw fail();
  if (options.requireRefresh && refresh === undefined) throw fail();
  if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer"))
    throw fail();
  const expiresIn = seconds(body.expires_in);
  if (expiresIn === undefined || !Number.isInteger(expiresIn) || expiresIn > MAX_EXPIRES_IN)
    throw fail();
  let earliestRefreshAt: string | undefined;
  if (body.earliest_refresh_at !== undefined) {
    const at = seconds(body.earliest_refresh_at);
    if (at === undefined) throw fail();
    // Informational only; stored in milliseconds like `expires` (spec 025 D29).
    earliestRefreshAt = String(Math.round(at * 1000));
  }
  return {
    access,
    ...(typeof refresh === "string" ? { refresh } : {}),
    expires: now + expiresIn * 1000,
    ...(earliestRefreshAt ? { earliestRefreshAt } : {}),
  };
}

const errorCode = (body: unknown) => {
  if (!isRecord(body)) return undefined;
  return safeCode(body.error) ?? (isRecord(body.error) ? safeCode(body.error.code) : undefined);
};

async function postForm(deps: TokenDeps, form: Record<string, string>, signal: AbortSignal) {
  let response: Response;
  try {
    response = await deps.fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal,
    });
  } catch {
    throw new ChatGPTError(
      signal.aborted
        ? "ChatGPT sign-in request was cancelled or timed out"
        : "Could not reach the ChatGPT sign-in service",
      { retryable: true },
    );
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text.length <= MAX_BODY ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

export async function exchangeCode(
  deps: TokenDeps,
  input: { clientId: string; code: string; redirectUri: string; verifier: string },
  signal: AbortSignal,
): Promise<TokenSet> {
  const { status, body } = await postForm(
    deps,
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      resource: RESOURCE,
    },
    signal,
  );
  if (status !== 200) {
    const code = errorCode(body);
    throw new ChatGPTError(`ChatGPT sign-in failed (HTTP ${status}${code ? `, ${code}` : ""})`);
  }
  return parseTokenResponse(body, deps.now(), { requireRefresh: true });
}

/**
 * Renews a SIWC credential. The refresh token rotates; when the response omits one the old token
 * is kept (it stays accepted, spec 025 D-35). `invalid_grant`, revocation and other client errors
 * are permanent; network failures, timeouts, 429 and 5xx are retryable.
 */
export async function refreshCredential(
  deps: TokenDeps,
  credential: ProviderOAuthCredential,
  signal: AbortSignal,
): Promise<ProviderOAuthCredential> {
  const clientId = credential.metadata?.clientId;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId) || !credential.refresh)
    throw signInAgain();
  const { status, body } = await postForm(
    deps,
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: credential.refresh,
      resource: RESOURCE,
    },
    signal,
  );
  if (status === 429 || status >= 500)
    throw new ChatGPTError(`ChatGPT sign-in service is unavailable (HTTP ${status})`, {
      retryable: true,
    });
  if (status !== 200) throw signInAgain(errorCode(body));
  const tokens = parseTokenResponse(body, deps.now(), { requireRefresh: false, retryable: true });
  const hostId = credential.metadata?.hostId;
  return {
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh ?? credential.refresh,
    expires: tokens.expires,
    metadata: {
      clientId,
      ...(hostId ? { hostId } : {}),
      ...(tokens.earliestRefreshAt ? { earliestRefreshAt: tokens.earliestRefreshAt } : {}),
    },
  };
}
