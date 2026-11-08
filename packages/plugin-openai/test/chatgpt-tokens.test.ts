import type { ProviderOAuthCredential } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { createBrowserMethod } from "../src/chatgpt/index.js";
import { fakeCtx, fakeFetch, json, tokenBody, untilAuthUrl } from "./helpers.js";

const NOW = 1_700_000_000_000;
const signIn = async (body: unknown) => {
  const method = createBrowserMethod({
    fetch: fakeFetch(() => json(200, body)).fetch,
    now: () => NOW,
  });
  const fake = fakeCtx();
  const running = method.start(fake.ctx);
  const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
  fake.loop.deliver({ code: "c", state, client_id: "issued" });
  return running;
};
const stored: ProviderOAuthCredential = {
  type: "oauth",
  access: "access-old",
  refresh: "refresh-old",
  expires: NOW,
  metadata: { clientId: "issued", hostId: "urn:uuid:11111111-2222-4333-8444-555555555555" },
};

describe("ChatGPT credential and refresh", () => {
  it("PO-AC-06: credential carries tokens, expiry and metadata without account id", async () => {
    const cred = await signIn(tokenBody(1, { earliest_refresh_at: 1_700_000_600 }));
    expect(cred).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW + 3_600_000,
      metadata: {
        clientId: "issued",
        hostId: expect.stringMatching(/^urn:uuid:/),
        earliestRefreshAt: "1700000600000",
      },
    });
    expect(cred.metadata).not.toHaveProperty("accountId");
  });

  it("PO-AC-06: earliestRefreshAt is omitted when the server does not send it", async () => {
    const cred = await signIn(tokenBody(1));
    expect(cred.metadata).not.toHaveProperty("earliestRefreshAt");
  });

  it("PO-AC-06: malformed token responses are rejected", async () => {
    for (const body of [
      {},
      tokenBody(1, { access_token: "" }),
      tokenBody(1, { access_token: 5 }),
      tokenBody(1, { refresh_token: undefined }),
      tokenBody(1, { expires_in: -1 }),
      tokenBody(1, { expires_in: "soon" }),
      tokenBody(1, { token_type: "mac" }),
      tokenBody(1, { earliest_refresh_at: "x" }),
      [],
    ])
      await expect(signIn(body)).rejects.toThrow(/invalid token response/i);
  });

  it("PO-AC-07: refresh rotates with the issued client id and resource", async () => {
    const server = fakeFetch(() => json(200, tokenBody(2)));
    const method = createBrowserMethod({ fetch: server.fetch, now: () => NOW });
    const next = await method.refresh?.(stored, AbortSignal.timeout(1000));
    expect(next).toEqual({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: NOW + 3_600_000,
      metadata: { clientId: "issued", hostId: stored.metadata?.hostId },
    });
    const form = new URLSearchParams(server.calls[0]?.body);
    expect(server.calls[0]?.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: "issued",
      refresh_token: "refresh-old",
      resource: "https://api.openai.com/v1",
    });
  });

  it("PO-AC-07: keeps the old refresh token when the response omits one", async () => {
    const server = fakeFetch(() => json(200, tokenBody(2, { refresh_token: undefined })));
    const method = createBrowserMethod({ fetch: server.fetch, now: () => NOW });
    expect((await method.refresh?.(stored, AbortSignal.timeout(1000)))?.refresh).toBe(
      "refresh-old",
    );
  });

  it("PO-AC-07: invalid_grant and revocation are permanent", async () => {
    for (const [status, body] of [
      [400, { error: "invalid_grant", error_description: "revoked" }],
      [401, { error: { code: "token_revoked" } }],
    ] as const) {
      const method = createBrowserMethod({ fetch: fakeFetch(() => json(status, body)).fetch });
      const error = await method.refresh?.(stored, AbortSignal.timeout(1000)).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/sign in again/i);
      expect(error.retryable).toBeUndefined();
    }
  });

  it("PO-AC-07: network failures and 5xx are retryable", async () => {
    for (const fetch of [
      fakeFetch(() => {
        throw new TypeError("fetch failed");
      }).fetch,
      fakeFetch(() => json(503, { error: "unavailable" })).fetch,
    ]) {
      const method = createBrowserMethod({ fetch });
      const error = await method.refresh?.(stored, AbortSignal.timeout(1000)).catch((e) => e);
      expect(error.retryable).toBe(true);
    }
  });

  it("PO-AC-07: a credential without its issued client id cannot refresh", async () => {
    const server = fakeFetch(() => json(200, tokenBody(2)));
    const method = createBrowserMethod({ fetch: server.fetch });
    const error = await method
      .refresh?.({ ...stored, metadata: {} }, AbortSignal.timeout(1000))
      .catch((e) => e);
    expect(error.message).toMatch(/sign in again/i);
    expect(error.retryable).toBeUndefined();
    expect(server.calls).toHaveLength(0);
  });
});
