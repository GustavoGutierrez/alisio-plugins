import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  ProviderAuthContext,
  ProviderAuthLoopback,
  ProviderAuthMethod,
  ProviderOAuthCredential,
} from "@alisio/sdk";
import {
  AGENT_NAME,
  AUTHORIZE_URL,
  CALLBACK_PATH,
  CALLBACK_PORT,
  DYNAMIC_CLIENT_ID,
  REDIRECT_URI,
  RESOURCE,
  SCOPE,
} from "./constants.js";
import { ChatGPTError, safeCode } from "./errors.js";
import { createPkce, type RandomBytes, randomToken, sameValue } from "./pkce.js";
import { exchangeCode, refreshCredential, type TokenDeps } from "./tokens.js";

/** Injectable dependencies; the defaults are Node built-ins. */
export interface ChatGPTDeps {
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: RandomBytes;
  randomUUID?: () => string;
}

export const resolveDeps = (deps: ChatGPTDeps = {}) => ({
  fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  now: deps.now ?? Date.now,
  randomBytes: deps.randomBytes ?? nodeRandomBytes,
  randomUUID: deps.randomUUID ?? nodeRandomUUID,
});

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CODE = /^[\x21-\x7e]{1,4096}$/;
const MAX_PASTE = 8192;

const SSH_HINT = `ssh -L ${CALLBACK_PORT}:127.0.0.1:${CALLBACK_PORT} <host>`;
const INSTRUCTIONS =
  "Sign in with your ChatGPT Plus/Pro account and approve Alisio; usage counts against your " +
  `ChatGPT plan. If Alisio runs on another machine, first forward the callback port with ` +
  `${SSH_HINT}. If the browser ends on an error page after you approve, copy its full address ` +
  "and paste it when asked.";
const PROMPT =
  "If your browser did not return to Alisio on its own, paste the full address of the page it " +
  `stopped on (it starts with ${REDIRECT_URI}).`;
const NO_WAY =
  "ChatGPT sign-in needs the browser redirect: forward the callback port with " +
  `${SSH_HINT} and start again, or paste the full redirect URL when asked.`;

export function authorizeUrl(input: {
  redirectUri: string;
  challenge: string;
  state: string;
  nonce: string;
  hostId: string;
}) {
  const url = new URL(AUTHORIZE_URL);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: DYNAMIC_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    nonce: input.nonce,
    resource: RESOURCE,
    ext_agent_host_id: input.hostId,
    agent_name_hint: AGENT_NAME,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/** Reads the query of a pasted redirect: a full URL or a bare `code=…&state=…` string. */
export function readPastedRedirect(value: string): Record<string, string> {
  const text = value.trim();
  const bad = () => new ChatGPTError("The pasted text is not the sign-in redirect URL");
  if (!text || text.length > MAX_PASTE) throw bad();
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(text)) {
    try {
      params = new URL(text).searchParams;
    } catch {
      throw bad();
    }
  } else params = new URLSearchParams(text.replace(/^[?#]/, ""));
  return Object.fromEntries(params);
}

/** Validates the redirect parameters against this attempt. Messages never echo values. */
export function readCallback(params: Record<string, string>, state: string) {
  if (params.error !== undefined) {
    const code = safeCode(params.error);
    throw new ChatGPTError(`ChatGPT sign-in was not completed${code ? ` (${code})` : ""}`);
  }
  if (typeof params.state !== "string" || !sameValue(params.state, state))
    throw new ChatGPTError(
      "The sign-in response does not match this attempt (state mismatch): start again",
    );
  const { code, client_id: clientId } = params;
  if (typeof code !== "string" || !CODE.test(code))
    throw new ChatGPTError("The sign-in response has no authorization code");
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId))
    throw new ChatGPTError(
      "The sign-in response has no issued client id, so Alisio was not registered with your " +
        "ChatGPT account",
    );
  return { code, clientId };
}

async function openLoopback(ctx: ProviderAuthContext, state: string) {
  if (!ctx.loopback) return undefined;
  let loop: ProviderAuthLoopback;
  try {
    loop = await ctx.loopback({
      port: CALLBACK_PORT,
      path: CALLBACK_PATH,
      state,
      redirectHost: "127.0.0.1",
    });
  } catch {
    // `loopback_unavailable` (port in use) or any bind failure: fall back to paste. There is no
    // retry on a random port, because SIWC acceptance of other ports is unverified (spec 025 D2).
    return undefined;
  }
  if (loop.redirectUri !== REDIRECT_URI) {
    loop.close();
    return undefined;
  }
  return loop;
}

const cancelled = () => new ChatGPTError("ChatGPT sign-in was cancelled");

/** Races the loopback redirect against a pasted URL: the first wins, the other is dropped. */
function waitForRedirect(
  ctx: ProviderAuthContext,
  loop: ProviderAuthLoopback | undefined,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      ctx.signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    if (ctx.signal.aborted) return onAbort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    loop?.wait().then(
      (params) => finish(() => resolve(params)),
      () =>
        finish(() => reject(new ChatGPTError("The browser sign-in did not reach Alisio in time"))),
    );
    const noAnswer = () => {
      if (!loop) finish(() => reject(new ChatGPTError(NO_WAY)));
    };
    ctx.prompt({ message: PROMPT, placeholder: `${REDIRECT_URI}?code=…` }).then((value) => {
      if (done) return;
      if (value === undefined) return noAnswer();
      try {
        const params = readPastedRedirect(value);
        finish(() => resolve(params));
      } catch (error) {
        finish(() => reject(error));
      }
    }, noAnswer);
  });
}

/**
 * The `browser` sign-in method: SIWC authorization code with PKCE S256 and dynamic agent
 * registration (spec 025 §5.8, D-30). One `hostId` is reused per chain of attempts until a
 * sign-in succeeds (D30), so cancelled attempts do not register duplicate agents.
 */
export function createBrowserMethod(options: ChatGPTDeps = {}): ProviderAuthMethod {
  const deps = resolveDeps(options);
  const tokenDeps: TokenDeps = { fetch: deps.fetch, now: deps.now };
  let chainHostId: string | undefined;
  return {
    id: "browser",
    kind: "oauth",
    label: "Continue with ChatGPT",
    description:
      "Using ChatGPT plan (Plus/Pro): sign in with your ChatGPT account in the browser. Usage " +
      "counts against your ChatGPT plan, not API billing. Preview: some API features are limited.",
    async start(ctx): Promise<ProviderOAuthCredential> {
      const previous = ctx.previousMetadata?.hostId;
      if (!previous || !HOST_ID.test(previous)) chainHostId ??= `urn:uuid:${deps.randomUUID()}`;
      const hostId = previous && HOST_ID.test(previous) ? previous : (chainHostId as string);
      const pkce = createPkce(deps.randomBytes);
      const state = randomToken(deps.randomBytes);
      const nonce = randomToken(deps.randomBytes);
      const loop = await openLoopback(ctx, state);
      try {
        ctx.show({
          type: "auth_url",
          url: authorizeUrl({
            redirectUri: REDIRECT_URI,
            challenge: pkce.challenge,
            state,
            nonce,
            hostId,
          }),
          instructions: INSTRUCTIONS,
        });
        const { code, clientId } = readCallback(await waitForRedirect(ctx, loop), state);
        const tokens = await exchangeCode(
          tokenDeps,
          { clientId, code, redirectUri: REDIRECT_URI, verifier: pkce.verifier },
          ctx.signal,
        );
        chainHostId = undefined;
        return {
          type: "oauth",
          access: tokens.access,
          ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
          expires: tokens.expires,
          metadata: {
            clientId,
            hostId,
            ...(tokens.earliestRefreshAt ? { earliestRefreshAt: tokens.earliestRefreshAt } : {}),
          },
        };
      } finally {
        loop?.close();
      }
    },
    refresh: (credential, signal) => refreshCredential(tokenDeps, credential, signal),
  };
}
