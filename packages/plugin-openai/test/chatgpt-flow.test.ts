import type {
  ModelProvider,
  ProviderAuthMethod,
  ProviderOAuthCredential,
  ProviderOAuthHandle,
} from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIPlugin } from "../src/index.js";
import {
  completed,
  fakeCtx,
  fakeFetch,
  json,
  registration,
  sse,
  tokenBody,
  untilAuthUrl,
} from "./helpers.js";

/**
 * Plugin-side simulation of the host contract (spec 025 §5.3): stores the credential, renews
 * 5 min before expiry or after invalidate(), and marks needs_sign_in on permanent failure. It
 * stands in for the real Alisio host, which this repository cannot run.
 */
function simulatedHost(method: ProviderAuthMethod, clock: { now: number }) {
  let cred: ProviderOAuthCredential | undefined;
  let state: "ok" | "needs_sign_in" = "ok";
  let rejected: string | undefined;
  const signInRequired = () =>
    Object.assign(new Error("Sign in again from /connect"), { code: "OAUTH_SIGN_IN_REQUIRED" });
  const handle: ProviderOAuthHandle = {
    async get(signal) {
      if (!cred || state === "needs_sign_in") throw signInRequired();
      const due = cred.expires !== undefined && cred.expires - clock.now <= 300_000;
      if (due || rejected === cred.access) {
        try {
          const next = await method.refresh?.(cred, signal ?? AbortSignal.timeout(10_000));
          if (!next) throw new Error("no refresh");
          cred = { ...next, metadata: { ...cred.metadata, ...next.metadata } };
          rejected = undefined;
        } catch (error) {
          if ((error as { retryable?: boolean }).retryable !== true) state = "needs_sign_in";
          throw signInRequired();
        }
      }
      return cred;
    },
    async invalidate(reason) {
      if (reason !== undefined) state = "needs_sign_in";
      else rejected = cred?.access;
    },
  };
  return {
    handle,
    get state() {
      return state;
    },
    get cred() {
      return cred;
    },
    async signIn() {
      const fake = fakeCtx();
      const running = method.start(fake.ctx);
      const url = await untilAuthUrl(fake);
      // The "browser" follows the redirect to the host's loopback listener.
      fake.loop.deliver({
        code: "browser-code",
        state: url.searchParams.get("state") as string,
        client_id: "issued",
      });
      cred = await running;
      state = "ok";
    },
  };
}

const ask = async (p: ModelProvider) => {
  for await (const _ of p.stream({
    instructions: "x",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    maxOutputTokens: 1,
    signal: AbortSignal.timeout(2000),
  }));
};

describe("ChatGPT end to end against a simulated host", () => {
  it("PO-AC-14 (plugin side): sign in, bearer request, forced expiry renews", async () => {
    const clock = { now: 1_000_000 };
    let refreshes = 0;
    const server = fakeFetch((call) => {
      if (call.url.endsWith("/oauth/token")) {
        const grant = new URLSearchParams(call.body).get("grant_type");
        if (grant === "refresh_token") refreshes += 1;
        return json(200, tokenBody(grant === "refresh_token" ? 1 + refreshes : 1));
      }
      return sse(completed());
    });
    const plugin = createOpenAIPlugin({ chatgpt: { fetch: server.fetch, now: () => clock.now } });
    const reg = registration(plugin, "chatgpt");
    const host = simulatedHost(reg.auth?.[0] as ProviderAuthMethod, clock);
    await host.signIn();
    const p = await reg.create({ profile: { model: "m" }, credentials: {}, oauth: host.handle });
    await ask(p);
    clock.now += 3_600_000;
    await ask(p);
    const bearers = server.calls
      .filter((c) => c.url.endsWith("/responses"))
      .map((c) => c.headers.get("authorization"));
    expect(bearers).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(host.cred?.metadata).toMatchObject({ clientId: "issued" });
  });

  it("PO-AC-17 (plugin side): revoked refresh needs sign-in and ignores OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-key-value");
    const clock = { now: 1_000_000 };
    const server = fakeFetch((call) => {
      if (call.url.endsWith("/oauth/token")) {
        const grant = new URLSearchParams(call.body).get("grant_type");
        return grant === "refresh_token"
          ? json(400, { error: "invalid_grant" })
          : json(200, tokenBody(1));
      }
      return sse(completed());
    });
    const reg = registration(
      createOpenAIPlugin({ chatgpt: { fetch: server.fetch, now: () => clock.now } }),
      "chatgpt",
    );
    const host = simulatedHost(reg.auth?.[0] as ProviderAuthMethod, clock);
    await host.signIn();
    const p = await reg.create({ profile: { model: "m" }, credentials: {}, oauth: host.handle });
    clock.now += 3_600_000;
    await expect(ask(p)).rejects.toThrow(/sign in again/i);
    expect(host.state).toBe("needs_sign_in");
    expect(host.cred?.access).toBe("access-1");
    expect(server.calls.some((c) => c.headers.get("authorization")?.includes("env-key"))).toBe(
      false,
    );
    vi.unstubAllEnvs();
  });
});
