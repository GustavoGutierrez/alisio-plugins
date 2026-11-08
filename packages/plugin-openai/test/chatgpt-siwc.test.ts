import { describe, expect, it } from "vitest";
import { createBrowserMethod } from "../src/chatgpt/index.js";
import { counterBytes, fakeCtx, fakeFetch, json, tokenBody, untilAuthUrl } from "./helpers.js";

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tokenServer = () => fakeFetch(() => json(200, tokenBody(1)));

describe("Sign in with ChatGPT authorization", () => {
  it("PO-AC-03: builds the SIWC authorize URL and exchanges with the issued client id", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch, now: () => 1_000 });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("ext_agent_host_id")).toMatch(HOST_ID);
    expect(q.get("agent_name_hint")).toBe("Alisio");
    expect(q.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(q.get("resource")).toBe("https://api.openai.com/v1");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("nonce")).toBeTruthy();
    fake.loop.deliver({ code: "the-code", state: q.get("state") as string, client_id: "issued_1" });
    const cred = await running;
    expect(cred.metadata?.clientId).toBe("issued_1");
    expect(cred.metadata?.hostId).toBe(q.get("ext_agent_host_id"));
    const exchange = new URLSearchParams(server.calls[0]?.body);
    expect(server.calls[0]?.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(server.calls[0]?.method).toBe("POST");
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("client_id")).toBe("issued_1");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(exchange.get("client_secret")).toBeNull();
  });

  it("PO-AC-03: reuses previousMetadata.hostId", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const hostId = "urn:uuid:11111111-2222-4333-8444-555555555555";
    const fake = fakeCtx({ previousMetadata: { hostId, clientId: "old" } });
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    expect(url.searchParams.get("ext_agent_host_id")).toBe(hostId);
    fake.loop.deliver({
      code: "c",
      state: url.searchParams.get("state") as string,
      client_id: "n",
    });
    expect((await running).metadata?.hostId).toBe(hostId);
  });

  it("PO-AC-03: a redirect without an issued client_id fails with no credential", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    fake.loop.deliver({ code: "c", state: url.searchParams.get("state") as string });
    await expect(running).rejects.toThrow(/client id/i);
    expect(server.calls).toHaveLength(0);
  });

  it("PO-AC-21: one hostId per attempt chain, discarded after success", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch, randomBytes: counterBytes() });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const fake = fakeCtx();
      const running = method.start(fake.ctx);
      running.catch(() => {});
      const url = await untilAuthUrl(fake);
      ids.push(url.searchParams.get("ext_agent_host_id") as string);
      if (i < 2) {
        fake.controller.abort();
        await expect(running).rejects.toThrow();
      } else {
        fake.loop.deliver({
          code: "c",
          state: url.searchParams.get("state") as string,
          client_id: "issued",
        });
        expect((await running).metadata?.hostId).toBe(ids[0]);
      }
    }
    expect(new Set(ids).size).toBe(1);
    const again = fakeCtx({ previousMetadata: { hostId: ids[0] as string } });
    const withPrevious = method.start(again.ctx);
    withPrevious.catch(() => {});
    expect((await untilAuthUrl(again)).searchParams.get("ext_agent_host_id")).toBe(ids[0]);
    again.controller.abort();
    const fresh = fakeCtx();
    const next = method.start(fresh.ctx);
    next.catch(() => {});
    expect((await untilAuthUrl(fresh)).searchParams.get("ext_agent_host_id")).not.toBe(ids[0]);
    fresh.controller.abort();
  });
});
