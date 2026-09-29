import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleChatError } from "./errors.js";

/**
 * The installed Alisio SDK exposes no tool-level configuration or secret API, so
 * this plugin reads its settings from the process environment only. Credentials
 * are never accepted through tool input, written to disk, logged, or serialized.
 *
 * TWO INDEPENDENT, FAIL-CLOSED MODES:
 *   - Webhook mode (`GOOGLE_CHAT_WEBHOOK_URL`): send-only, near-zero setup.
 *   - OAuth user mode (`GOOGLE_CHAT_CLIENT_ID` + `GOOGLE_CHAT_CLIENT_SECRET`):
 *     listing, searching, sending, editing (text only), and deleting.
 */
export type Environment = Record<string, string | undefined>;

export const ENV = {
  webhookUrl: "GOOGLE_CHAT_WEBHOOK_URL",
  clientId: "GOOGLE_CHAT_CLIENT_ID",
  clientSecret: "GOOGLE_CHAT_CLIENT_SECRET",
  scopes: "GOOGLE_CHAT_SCOPES",
  tokenFile: "GOOGLE_CHAT_TOKEN_FILE",
  authTimeoutMs: "GOOGLE_CHAT_AUTH_TIMEOUT_MS",
  configHome: "ALISIO_CONFIG_HOME",
  xdgConfigHome: "XDG_CONFIG_HOME",
  home: "HOME",
} as const;

/** Fixed official origins this plugin is ever allowed to transmit to. */
export const CHAT_API_ORIGIN = "https://chat.googleapis.com";
export const OAUTH_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
/** Browser authorization endpoint. It is printed for the user to open, never fetched by the plugin. */
export const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Scopes requested by default: read, manage, and delete messages, list spaces and members. */
export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
] as const;

const CHAT_SCOPE = /^https:\/\/www\.googleapis\.com\/auth\/chat\.[a-z.]+$/;
const WEBHOOK_PATH = /^\/v1\/spaces\/[A-Za-z0-9_-]{1,200}\/messages$/;
const SAFE_PARAM = /^[A-Za-z0-9_-]{1,1024}$/;
const ALLOWED_WEBHOOK_PARAMS = new Set(["key", "token", "messageReplyOption"]);
const DEFAULT_AUTH_TIMEOUT_MS = 300_000;
const MIN_AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_TIMEOUT_MS = 900_000;

/** How long before real expiry a token is treated as expired and refreshed. */
export const TOKEN_SKEW_MS = 60_000;

/**
 * A validated incoming-webhook target. The raw URL carries a secret `token`
 * query parameter, so it is attached as a non-enumerable property: `url` is
 * usable at request time but never appears in `JSON.stringify`, `util.inspect`,
 * an error, a tool result, or a log line.
 */
export interface WebhookTarget {
  readonly origin: string;
  readonly space: string;
  readonly hasKey: boolean;
  readonly hasToken: boolean;
  /** The full secret webhook URL. Non-enumerable by construction. */
  readonly url: string;
}

export interface OAuthConfig {
  readonly clientId: string;
  /** Client secret. Non-enumerable so it never serializes or prints. */
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly tokenFile: string;
}

export interface GoogleChatConfig {
  readonly webhook: WebhookTarget | undefined;
  readonly oauth: OAuthConfig | undefined;
  readonly authTimeoutMs: number;
  readonly tokenSkewMs: number;
}

function fail(detail: string): never {
  throw new GoogleChatError("configuration missing or invalid", detail);
}

function readTrimmed(env: Environment, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/**
 * Validate an incoming webhook URL. Only an HTTPS URL on the official Chat API
 * origin, on the exact `messages` collection path, with no credentials and no
 * unexpected query parameters, is accepted.
 */
export function parseWebhookUrl(raw: string): WebhookTarget {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    fail("GOOGLE_CHAT_WEBHOOK_URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:") fail("GOOGLE_CHAT_WEBHOOK_URL must use https");
  if (url.username !== "" || url.password !== "")
    fail("GOOGLE_CHAT_WEBHOOK_URL must not embed credentials");
  if (url.hash !== "") fail("GOOGLE_CHAT_WEBHOOK_URL must not include a fragment");
  if (url.origin !== CHAT_API_ORIGIN)
    fail(`GOOGLE_CHAT_WEBHOOK_URL must point at ${CHAT_API_ORIGIN}`);
  if (!WEBHOOK_PATH.test(url.pathname))
    fail(
      "GOOGLE_CHAT_WEBHOOK_URL must be a https://chat.googleapis.com/v1/spaces/{space}/messages URL",
    );
  if (!url.searchParams.has("key"))
    fail("GOOGLE_CHAT_WEBHOOK_URL is missing its `key` query parameter");
  const token = url.searchParams.get("token");
  if (token === null || token === "")
    fail("GOOGLE_CHAT_WEBHOOK_URL is missing its `token` query parameter");
  for (const key of url.searchParams.keys())
    if (!ALLOWED_WEBHOOK_PARAMS.has(key))
      fail(`GOOGLE_CHAT_WEBHOOK_URL has an unexpected query parameter "${key}"`);
  for (const value of url.searchParams.values())
    if (!SAFE_PARAM.test(value))
      fail("GOOGLE_CHAT_WEBHOOK_URL query values must be URL-safe tokens");
  const spaceId = url.pathname.split("/")[3];
  if (spaceId === undefined || !/^[A-Za-z0-9_-]{1,200}$/.test(spaceId))
    fail("GOOGLE_CHAT_WEBHOOK_URL has an invalid space id");

  const target = {
    origin: CHAT_API_ORIGIN,
    space: `spaces/${spaceId}`,
    hasKey: true,
    hasToken: true,
  } as unknown as WebhookTarget;
  Object.defineProperty(target, "url", {
    value: url.toString(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(target);
}

/** Normalize a comma- or space-separated scope list; only Chat API scopes are accepted. */
export function parseScopes(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_SCOPES;
  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  if (scopes.length === 0) return DEFAULT_SCOPES;
  for (const scope of scopes)
    if (!CHAT_SCOPE.test(scope))
      fail(`GOOGLE_CHAT_SCOPES must contain only Google Chat API scopes, got "${scope}"`);
  return Object.freeze([...new Set(scopes)]);
}

/** Resolve the Alisio config home with the documented precedence. */
export function resolveConfigHome(env: Environment = process.env): string {
  const home = env[ENV.home]?.trim() || homedir();
  const xdg = env[ENV.xdgConfigHome]?.trim();
  return (
    env[ENV.configHome]?.trim() || (xdg ? join(xdg, "alisio") : join(home, ".config", "alisio"))
  );
}

/** The plugin-owned token file: `<configHome>/google-chat/token.json`. */
export function resolveTokenFile(
  env: Environment = process.env,
  override?: string | undefined,
): string {
  const explicit = override?.trim() || env[ENV.tokenFile]?.trim();
  return explicit || join(resolveConfigHome(env), "google-chat", "token.json");
}

function parseAuthTimeout(env: Environment): number {
  const raw = readTrimmed(env, ENV.authTimeoutMs);
  if (raw === undefined) return DEFAULT_AUTH_TIMEOUT_MS;
  if (!/^[0-9]{1,9}$/.test(raw)) fail("GOOGLE_CHAT_AUTH_TIMEOUT_MS must be an integer");
  const value = Number.parseInt(raw, 10);
  if (value < MIN_AUTH_TIMEOUT_MS || value > MAX_AUTH_TIMEOUT_MS)
    fail(
      `GOOGLE_CHAT_AUTH_TIMEOUT_MS must be between ${MIN_AUTH_TIMEOUT_MS} and ${MAX_AUTH_TIMEOUT_MS}`,
    );
  return value;
}

/**
 * Resolve the full configuration. A partially configured OAuth mode is an
 * operator error and fails closed. With neither mode configured the plugin
 * still loads so `google-chat:status` can explain what is missing, but every
 * capability fails with an actionable message.
 */
export function loadConfig(env: Environment = process.env): GoogleChatConfig {
  const webhookRaw = readTrimmed(env, ENV.webhookUrl);
  const clientId = readTrimmed(env, ENV.clientId);
  const clientSecret = readTrimmed(env, ENV.clientSecret);

  if ((clientId === undefined) !== (clientSecret === undefined))
    fail(`${ENV.clientId} and ${ENV.clientSecret} must be set together to enable OAuth user mode`);

  const webhook = webhookRaw === undefined ? undefined : parseWebhookUrl(webhookRaw);

  let oauth: OAuthConfig | undefined;
  if (clientId !== undefined && clientSecret !== undefined) {
    const oauthConfig = {
      clientId,
      scopes: parseScopes(readTrimmed(env, ENV.scopes)),
      tokenFile: resolveTokenFile(env),
    } as unknown as OAuthConfig;
    Object.defineProperty(oauthConfig, "clientSecret", {
      value: clientSecret,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    oauth = Object.freeze(oauthConfig);
  }

  const config: GoogleChatConfig = {
    webhook,
    oauth,
    authTimeoutMs: parseAuthTimeout(env),
    tokenSkewMs: TOKEN_SKEW_MS,
  };
  return Object.freeze(config);
}

/** A secret-free description of what is configured, for `google-chat:status`. */
export function describeConfig(config: GoogleChatConfig): {
  webhookConfigured: boolean;
  webhookSpace: string | null;
  oauthClientConfigured: boolean;
  scopes: readonly string[];
  tokenFile: string | null;
} {
  return {
    webhookConfigured: config.webhook !== undefined,
    webhookSpace: config.webhook?.space ?? null,
    oauthClientConfigured: config.oauth !== undefined,
    scopes: config.oauth?.scopes ?? [],
    tokenFile: config.oauth?.tokenFile ?? null,
  };
}
