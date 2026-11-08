import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBrowserMethod } from "../src/chatgpt/index.js";
import { fakeCtx, fakeFetch, json, tick, tokenBody, untilAuthUrl } from "./helpers.js";

const tokenServer = () => fakeFetch(() => json(200, tokenBody(1)));

describe("Sign in with ChatGPT PKCE and redirect handling", () => {
  it("PO-AC-04: S256 challenge matches the verifier, which never leaves the exchange", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    const state = url.searchParams.get("state") as string;
    expect(fake.loop.options).toMatchObject({ port: 1455, path: "/auth/callback", state });
    fake.loop.deliver({ code: "c", state, client_id: "issued" });
    await running;
    const verifier = new URLSearchParams(server.calls[0]?.body).get("code_verifier") as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(JSON.stringify(fake.loop.options)).not.toContain(verifier);
    expect(JSON.stringify(fake.steps)).not.toContain(verifier);
    expect(JSON.stringify(fake.prompts)).not.toContain(verifier);
    expect(url.href).not.toContain(verifier);
    expect(fake.loop.closed).toBe(true);
  });

  it("PO-AC-04: state is random and distinct per attempt", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const states = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const fake = fakeCtx();
      const running = method.start(fake.ctx);
      running.catch(() => {});
      const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      states.add(state);
      fake.controller.abort();
    }
    expect(states.size).toBe(3);
  });

  it("PO-AC-04: a foreign state on the callback is rejected without an exchange", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    await untilAuthUrl(fake);
    fake.loop.deliver({ code: "c", state: "someone-else", client_id: "issued" });
    await expect(running).rejects.toThrow(/state/i);
    expect(server.calls).toHaveLength(0);
  });

  it("PO-AC-04: a busy port falls back to paste with no port 0 retry", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const fake = fakeCtx({ loopback: "busy" });
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    expect(fake.loop.options?.port).toBe(1455);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(fake.prompts).toHaveLength(1);
    const state = url.searchParams.get("state") as string;
    fake.answer(`http://127.0.0.1:1455/auth/callback?code=c&state=${state}&client_id=issued`);
    expect((await running).metadata?.clientId).toBe("issued");
  });

  it("PO-AC-05: a pasted redirect URL without loopback is exchanged", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx({ loopback: "none" });
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    expect(fake.prompts[0]?.message).toMatch(/paste/i);
    const state = url.searchParams.get("state") as string;
    fake.answer(` http://127.0.0.1:1455/auth/callback?code=c2&state=${state}&client_id=issued `);
    await running;
    expect(new URLSearchParams(server.calls[0]?.body).get("code")).toBe("c2");
  });

  it("PO-AC-05: a pasted URL with a foreign state fails", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx({ loopback: "none" });
    const running = method.start(fake.ctx);
    await untilAuthUrl(fake);
    fake.answer("http://127.0.0.1:1455/auth/callback?code=c&state=bad&client_id=issued");
    await expect(running).rejects.toThrow(/state/i);
    expect(server.calls).toHaveLength(0);
  });

  it("PO-AC-05: no loopback and an unanswered prompt fails with tunnel or paste advice", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const fake = fakeCtx({ loopback: "none" });
    const running = method.start(fake.ctx);
    await untilAuthUrl(fake);
    fake.answer(undefined);
    await expect(running).rejects.toThrow(/ssh -L 1455:127\.0\.0\.1:1455.*paste/is);
  });

  it("PO-AC-05: loopback wins the race and the paste is ignored", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const url = await untilAuthUrl(fake);
    const state = url.searchParams.get("state") as string;
    fake.loop.deliver({ code: "from-loop", state, client_id: "issued" });
    await tick();
    fake.answer(`http://127.0.0.1:1455/auth/callback?code=from-paste&state=${state}&client_id=x`);
    await running;
    expect(server.calls).toHaveLength(1);
    expect(new URLSearchParams(server.calls[0]?.body).get("code")).toBe("from-loop");
  });

  it("PO-AC-05: paste wins the race and the loopback is closed", async () => {
    const server = tokenServer();
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
    fake.answer(`http://127.0.0.1:1455/auth/callback?code=from-paste&state=${state}&client_id=i`);
    await running;
    expect(fake.loop.closed).toBe(true);
    expect(new URLSearchParams(server.calls[0]?.body).get("code")).toBe("from-paste");
  });

  it("PO-AC-05: with loopback, an unanswered prompt keeps waiting for the browser", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
    fake.answer(undefined);
    await tick();
    fake.loop.deliver({ code: "c", state, client_id: "issued" });
    expect((await running).type).toBe("oauth");
  });

  it("aborting the flow rejects and closes the loopback", async () => {
    const method = createBrowserMethod({ fetch: tokenServer().fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    await untilAuthUrl(fake);
    fake.controller.abort();
    await expect(running).rejects.toThrow(/cancel/i);
    expect(fake.loop.closed).toBe(true);
  });
});
