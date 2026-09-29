import { CHAT_API_ORIGIN, ENV, type GoogleChatConfig, type OAuthConfig } from "./config.js";
import { GoogleChatError } from "./errors.js";
import { type Clock, type Sleep, systemClock, systemSleep } from "./time.js";
import { obtainAccessToken, type TokenSet, type TokenStore } from "./token.js";
import {
  type Fetcher,
  MAX_RETRY_AFTER_SECONDS,
  type RawResponse,
  rawRequest,
  retryAfterSeconds,
} from "./transport.js";

export const MAX_RETRIES = 2;
export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8_000;

export type QueryValue = string | number | boolean | undefined | null;

/** Build an encoded query string from primitive values only. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (!/^[a-z0-9-]+$/i.test(key)) throw new GoogleChatError("invalid input", "invalid query key");
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export interface Capabilities {
  readonly mode: "oauth" | "webhook" | "none";
  readonly configured: boolean;
  readonly canRead: boolean;
  readonly canSend: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface ChatRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal: AbortSignal;
  /** True only for idempotent reads, which may be retried on 429/5xx. */
  idempotent?: boolean;
}

export interface SendMessageRequest {
  space: string | undefined;
  text: string;
  threadKey: string | undefined;
  replyOption: string | undefined;
  messageId: string | undefined;
  signal: AbortSignal;
}

export interface SendMessageResult {
  message: unknown;
  via: "oauth" | "webhook";
}

/**
 * A Google Chat client with two independent, fail-closed authentication modes.
 * Every request reaches one of two fixed official origins, follows no redirect,
 * and is bounded in time and size.
 */
export class GoogleChatClient {
  readonly config: GoogleChatConfig;
  readonly fetcher: Fetcher;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly tokenStore: TokenStore;

  constructor(
    config: GoogleChatConfig,
    fetcher: Fetcher = fetch,
    clock: Clock = systemClock,
    sleep: Sleep = systemSleep,
    tokenStore: TokenStore,
  ) {
    this.config = config;
    this.fetcher = fetcher;
    this.clock = clock;
    this.sleep = sleep;
    this.tokenStore = tokenStore;
  }

  capabilities(): Capabilities {
    const oauth = this.config.oauth !== undefined;
    const webhook = this.config.webhook !== undefined;
    return {
      mode: oauth ? "oauth" : webhook ? "webhook" : "none",
      configured: oauth || webhook,
      canRead: oauth,
      canSend: oauth || webhook,
      canEdit: oauth,
      canDelete: oauth,
    };
  }

  hasUserToken(): boolean {
    return this.tokenStore.read() !== null;
  }

  /** Prefer OAuth user identity when authenticated; otherwise use the webhook. */
  resolveSendMode(): "oauth" | "webhook" | "none" {
    if (this.config.oauth !== undefined && this.hasUserToken()) return "oauth";
    if (this.config.webhook !== undefined) return "webhook";
    return "none";
  }

  private requireUser(capability: string): OAuthConfig {
    if (this.config.oauth !== undefined) return this.config.oauth;
    const reason =
      this.config.webhook !== undefined
        ? "an incoming webhook can only send messages; reading, searching, editing, and deleting require OAuth user mode"
        : `set ${ENV.clientId} and ${ENV.clientSecret} (and run google-chat-auth) to enable it`;
    throw new GoogleChatError(
      "configuration missing or invalid",
      `${capability} requires OAuth user mode: ${reason}`,
    );
  }

  /** Authenticated Chat API request in OAuth user mode. */
  async request(spec: ChatRequest): Promise<unknown> {
    const oauth = this.requireUser("this operation");
    let token = await this.accessToken(oauth, spec.signal, false);
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const url = `${CHAT_API_ORIGIN}${spec.path}${buildQuery(spec.query ?? {})}`;
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `${token.tokenType} ${token.accessToken}`,
      };
      if (spec.body !== undefined) headers["content-type"] = "application/json";
      const response = await rawRequest({
        fetcher: this.fetcher,
        method: spec.method,
        url,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: spec.signal,
        origin: CHAT_API_ORIGIN,
      });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.accessToken(oauth, spec.signal, true);
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        spec.idempotent === true &&
        attempt < MAX_RETRIES
      ) {
        const delay = this.backoffMs(response.headers, attempt);
        await this.sleep(delay, spec.signal);
        attempt += 1;
        continue;
      }
      return this.handle(response);
    }
  }

  /** Send a message through OAuth user mode or the configured webhook. */
  async send(spec: SendMessageRequest): Promise<SendMessageResult> {
    const mode = this.resolveSendMode();
    if (mode === "none") {
      if (this.config.oauth !== undefined)
        throw new GoogleChatError(
          "not authenticated",
          "no stored Google authorization; run google-chat-auth to authorize a user account",
        );
      throw new GoogleChatError(
        "configuration missing or invalid",
        `set ${ENV.webhookUrl}, or ${ENV.clientId} and ${ENV.clientSecret}, to send messages`,
      );
    }
    const body: Record<string, unknown> = { text: spec.text };
    if (spec.threadKey !== undefined) body.thread = { threadKey: spec.threadKey };
    if (mode === "oauth") {
      const space = spec.space;
      if (space === undefined)
        throw new GoogleChatError("invalid input", '"space" is required in OAuth user mode');
      const query: Record<string, QueryValue> = {};
      if (spec.replyOption !== undefined) query.messageReplyOption = spec.replyOption;
      if (spec.messageId !== undefined) query.messageId = spec.messageId;
      const message = await this.request({
        method: "POST",
        path: `/v1/${space}/messages`,
        query,
        body,
        signal: spec.signal,
      });
      return { message, via: "oauth" };
    }
    const message = await this.sendViaWebhook(spec, body);
    return { message, via: "webhook" };
  }

  private async sendViaWebhook(
    spec: SendMessageRequest,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const webhook = this.config.webhook;
    if (webhook === undefined)
      throw new GoogleChatError("configuration missing or invalid", "no webhook is configured");
    if (spec.space !== undefined && spec.space !== webhook.space)
      throw new GoogleChatError(
        "invalid input",
        `the configured webhook only posts to ${webhook.space}`,
      );
    if (spec.messageId !== undefined)
      throw new GoogleChatError(
        "invalid input",
        "client-assigned message ids require OAuth user mode",
      );
    const url = new URL(webhook.url);
    if (spec.replyOption !== undefined)
      url.searchParams.set("messageReplyOption", spec.replyOption);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
    };
    const response = await rawRequest({
      fetcher: this.fetcher,
      method: "POST",
      url: url.toString(),
      headers,
      body: JSON.stringify(body),
      signal: spec.signal,
      origin: CHAT_API_ORIGIN,
    });
    return this.handle(response);
  }

  private async accessToken(
    oauth: OAuthConfig,
    signal: AbortSignal,
    force: boolean,
  ): Promise<TokenSet> {
    return obtainAccessToken(
      this.tokenStore,
      { oauth, fetcher: this.fetcher, clock: this.clock, signal, skewMs: this.config.tokenSkewMs },
      { force },
    );
  }

  private backoffMs(headers: Headers, attempt: number): number {
    const retryAfter = retryAfterSeconds(headers, this.clock.now(), MAX_RETRY_AFTER_SECONDS);
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    if (retryAfter !== undefined) return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
    return exponential;
  }

  private handle(response: RawResponse): unknown {
    const status = response.status;
    if (status >= 200 && status < 300) {
      if (status === 204 || status === 205) return {};
      if (response.text.trim() === "") return {};
      try {
        return JSON.parse(response.text);
      } catch {
        throw new GoogleChatError("invalid response");
      }
    }
    const retry = retryAfterSeconds(response.headers, this.clock.now(), MAX_RETRY_AFTER_SECONDS);
    const detail = retry === undefined ? undefined : `retry after ${retry} seconds`;
    if (status === 401) throw new GoogleChatError("not authenticated");
    if (status === 403)
      throw new GoogleChatError(
        "not permitted",
        "Google Chat returns 403 for inaccessible resources before confirming whether they exist",
      );
    if (status === 404) throw new GoogleChatError("not found");
    if (status === 400) throw new GoogleChatError("invalid input");
    if (status === 429) throw new GoogleChatError("rate limited", detail);
    if (status >= 500) throw new GoogleChatError("temporarily unavailable", detail);
    throw new GoogleChatError("invalid response");
  }
}
