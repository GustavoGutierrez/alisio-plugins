import type { ModelProvider, ProviderEvent, ProviderOAuthHandle } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIPlugin, OpenAIProvider } from "../src/index.js";
import { type Call, completed, fakeFetch, fakeHandle, json, registration, sse } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());

const provider = async (fetch: typeof globalThis.fetch, handle: ProviderOAuthHandle) =>
  registration(createOpenAIPlugin({ chatgpt: { fetch } }), "chatgpt").create({
    profile: { model: "gpt-5.6-terra" },
    credentials: {},
    oauth: handle,
  });
const run = async (p: ModelProvider) => {
  const items: ProviderEvent[] = [];
  for await (const e of p.stream({
    instructions: "test",
    messages: [{ role: "user", text: "hello" }],
    tools: [],
    maxOutputTokens: 12,
    signal: AbortSignal.timeout(2000),
  }))
    items.push(e);
  return items;
};
const bearer = (c: Call | undefined) => c?.headers.get("authorization");
const revoked = () =>
  json(
    401,
    { error: { code: "token_revoked", message: "revoked" } },
    { "x-openai-ide-error-code": "token_revoked" },
  );

describe("ChatGPT provider", () => {
  it("PO-AC-08: every request takes a fresh token from oauth.get()", async () => {
    const server = fakeFetch(() => sse(completed()));
    const { handle } = fakeHandle(["token-a", "token-b"]);
    let n = 0;
    const rotating: ProviderOAuthHandle = {
      get: async () => ({ type: "oauth", access: n++ === 0 ? "token-a" : "token-b" }),
      invalidate: handle.invalidate,
    };
    const p = await provider(server.fetch, rotating);
    expect(p).toBeInstanceOf(OpenAIProvider);
    await run(p);
    await run(p);
    expect(bearer(server.calls[0])).toBe("Bearer token-a");
    expect(bearer(server.calls[1])).toBe("Bearer token-b");
  });

  it("PO-AC-11: request goes to the public API with only bearer auth and preview-safe body", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    const server = fakeFetch(() => sse(completed("hi")));
    const events = await run(await provider(server.fetch, fakeHandle(["tok"]).handle));
    expect(events.at(-1)).toMatchObject({ type: "completed", message: { text: "hi" } });
    const call = server.calls[0];
    expect(call?.url).toBe("https://api.openai.com/v1/responses");
    for (const h of ["chatgpt-account-id", "openai-organization", "openai-project"])
      expect(call?.headers.has(h)).toBe(false);
    const body = JSON.parse(call?.body ?? "{}");
    expect(body).toMatchObject({ model: "gpt-5.6-terra", store: false, stream: true });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("PO-AC-11: listModels parses {models}, filters, sorts by priority", async () => {
    const server = fakeFetch(() =>
      json(200, {
        models: [
          { slug: "b", display_name: "B", visibility: "list", supported_in_api: true, priority: 2 },
          { slug: "hidden", visibility: "hide", supported_in_api: true, priority: 0 },
          { slug: "no-api", visibility: "list", supported_in_api: false, priority: 0 },
          {
            slug: "a",
            display_name: "A",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            context_window: 1000,
          },
          { slug: 5, visibility: "list", supported_in_api: true },
        ],
      }),
    );
    const p = await provider(server.fetch, fakeHandle(["tok"]).handle);
    expect(await p.listModels?.(AbortSignal.timeout(1000))).toEqual([
      { id: "a", name: "A", contextWindow: 1000 },
      { id: "b", name: "B" },
    ]);
    expect(server.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(server.calls[0]?.method).toBe("GET");
    expect(bearer(server.calls[0])).toBe("Bearer tok");
  });

  it("PO-AC-11: listModels also accepts the standard {data} shape", async () => {
    const server = fakeFetch(() => json(200, { data: [{ id: "x", owned_by: "openai" }] }));
    const p = await provider(server.fetch, fakeHandle(["tok"]).handle);
    expect(await p.listModels?.(AbortSignal.timeout(1000))).toEqual([
      { id: "x", ownedBy: "openai" },
    ]);
  });

  it("PO-AC-11: the static fallback is used only when the endpoint fails", async () => {
    for (const reply of [() => json(500, {}), () => json(200, { nope: true })]) {
      const p = await provider(fakeFetch(reply).fetch, fakeHandle(["tok"]).handle);
      const models = await p.listModels?.(AbortSignal.timeout(1000));
      expect(models?.length).toBeGreaterThan(0);
      expect(models?.[0]?.id).toMatch(/^gpt-/);
    }
  });

  it("PO-AC-09: a plain 401 renews once and retries", async () => {
    const server = fakeFetch((_c, n) => (n === 1 ? json(401, { error: {} }) : sse(completed())));
    const { handle, calls } = fakeHandle(["token-a", "token-b"]);
    await run(await provider(server.fetch, handle));
    expect(calls.invalidate).toEqual([undefined]);
    expect(bearer(server.calls[1])).toBe("Bearer token-b");
  });

  it("PO-AC-09: a second plain 401 marks sign-in required without looping", async () => {
    const server = fakeFetch(() => json(401, { error: {} }));
    const { handle, calls } = fakeHandle(["token-a", "token-b"]);
    await expect(run(await provider(server.fetch, handle))).rejects.toThrow(/sign in again/);
    expect(calls.invalidate).toEqual([undefined, "sign_in_required"]);
    expect(server.calls).toHaveLength(2);
  });

  it("PO-AC-09: models also renew once on a plain 401", async () => {
    const server = fakeFetch((_c, n) =>
      n === 1 ? json(401, {}) : json(200, { data: [{ id: "x" }] }),
    );
    const { handle, calls } = fakeHandle(["token-a", "token-b"]);
    const p = await provider(server.fetch, handle);
    expect(await p.listModels?.(AbortSignal.timeout(1000))).toEqual([{ id: "x" }]);
    expect(calls.invalidate).toEqual([undefined]);
  });

  it("PO-AC-20: token_revoked in inference requires sign-in with no retry", async () => {
    for (const reply of [
      revoked,
      () => json(401, { error: { code: "token_revoked" } }),
      () => json(401, {}, { "x-openai-ide-error-code": "token_revoked" }),
    ]) {
      const server = fakeFetch(reply);
      const { handle, calls } = fakeHandle(["secret-access-token"]);
      const error = await run(await provider(server.fetch, handle)).catch((e) => e);
      expect(error.message).toMatch(/sign in again/);
      expect(error.message).not.toContain("secret-access-token");
      expect(calls.invalidate).toEqual(["sign_in_required"]);
      expect(server.calls).toHaveLength(1);
    }
  });

  it("PO-AC-20: token_revoked on /v1/models requires sign-in and skips the fallback", async () => {
    const server = fakeFetch(revoked);
    const { handle, calls } = fakeHandle(["tok"]);
    const p = await provider(server.fetch, handle);
    await expect(p.listModels?.(AbortSignal.timeout(1000))).rejects.toThrow(/sign in again/);
    expect(calls.invalidate).toEqual(["sign_in_required"]);
    expect(server.calls).toHaveLength(1);
  });

  it("host sign-in errors from oauth.get() surface unchanged", async () => {
    const server = fakeFetch(() => sse(completed()));
    const failing: ProviderOAuthHandle = {
      get: async () => {
        throw Object.assign(new Error("Sign in again from /connect"), {
          code: "OAUTH_SIGN_IN_REQUIRED",
        });
      },
      invalidate: async () => {},
    };
    const error = await run(await provider(server.fetch, failing)).catch((e) => e);
    expect(error.code).toBe("OAUTH_SIGN_IN_REQUIRED");
    expect(server.calls).toHaveLength(0);
  });

  it("subscription_sharing errors become a clear message", async () => {
    const server = fakeFetch(() =>
      json(403, { error: { code: "subscription_sharing_not_eligible", message: "x" } }),
    );
    const error = await run(await provider(server.fetch, fakeHandle(["tok"]).handle)).catch(
      (e) => e,
    );
    expect(error.message).toMatch(/ChatGPT plan.*subscription_sharing_not_eligible/);
  });
});
