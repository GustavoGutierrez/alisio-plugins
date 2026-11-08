import { inspect } from "node:util";
import type { ProviderOAuthCredential } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { createBrowserMethod } from "../src/chatgpt/index.js";
import { createOpenAIPlugin } from "../src/index.js";
import { fakeCtx, fakeFetch, fakeHandle, json, registration, untilAuthUrl } from "./helpers.js";

const JWT = [
  "eyJhbGciOiJSUzI1NiJ9",
  "eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4In0",
  "c2lnbmF0dXJlLXZhbHVl",
].join(".");
const ACCESS = "access-secret-value-123";
const REFRESH = "refresh-secret-value-456";
const CODE = "auth-code-secret-789";

const echo = (status: number) => (call: { body: string }) =>
  json(status, {
    error: {
      code: "server_error",
      message: `echo ${call.body} ${JWT} ${ACCESS} ${REFRESH} ${CODE}`,
    },
    error_description: `${JWT} ${call.body}`,
  });
const assertClean = (error: unknown, extra: string[] = []) => {
  expect(error).toBeInstanceOf(Error);
  const text = `${(error as Error).message} ${inspect(error)} ${JSON.stringify(error)}`;
  for (const s of [JWT, ACCESS, REFRESH, CODE, "eyJ", ...extra]) expect(text).not.toContain(s);
};

describe("ChatGPT redaction", () => {
  it("PO-AC-12: code exchange errors never echo tokens, code or verifier", async () => {
    const server = fakeFetch(echo(400));
    const method = createBrowserMethod({ fetch: server.fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
    fake.loop.deliver({ code: CODE, state, client_id: "issued" });
    const error = await running.catch((e) => e);
    const verifier = new URLSearchParams(server.calls[0]?.body).get("code_verifier") as string;
    assertClean(error, [verifier, state]);
  });

  it("PO-AC-12: a callback error parameter is not echoed unless it is a plain code", async () => {
    const method = createBrowserMethod({ fetch: fakeFetch(echo(400)).fetch });
    const fake = fakeCtx();
    const running = method.start(fake.ctx);
    const state = (await untilAuthUrl(fake)).searchParams.get("state") as string;
    fake.loop.deliver({ error: `${JWT} ${ACCESS}`, error_description: JWT, state });
    assertClean(await running.catch((e) => e));
  });

  it("PO-AC-12: refresh errors never echo tokens", async () => {
    const cred: ProviderOAuthCredential = {
      type: "oauth",
      access: ACCESS,
      refresh: REFRESH,
      metadata: { clientId: "issued" },
    };
    for (const status of [400, 500]) {
      const method = createBrowserMethod({ fetch: fakeFetch(echo(status)).fetch });
      assertClean(await method.refresh?.(cred, AbortSignal.timeout(1000)).catch((e) => e));
    }
  });

  it("PO-AC-12: inference and model errors never echo tokens", async () => {
    for (const status of [400, 401, 500]) {
      const p = await registration(
        createOpenAIPlugin({ chatgpt: { fetch: fakeFetch(echo(status)).fetch } }),
        "chatgpt",
      ).create({ profile: { model: "m" }, credentials: {}, oauth: fakeHandle([ACCESS]).handle });
      const stream = async () => {
        for await (const _ of p.stream({
          instructions: "x",
          messages: [{ role: "user", text: "hi" }],
          tools: [],
          maxOutputTokens: 1,
          signal: AbortSignal.timeout(1000),
        }));
      };
      assertClean(await stream().catch((e) => e));
      if (status !== 500) {
        const models = await p.listModels?.(AbortSignal.timeout(1000)).catch((e) => e);
        if (models instanceof Error) assertClean(models);
      }
      expect(JSON.stringify(p)).not.toContain(ACCESS);
      expect(inspect(p, { showHidden: true, depth: 6 })).not.toContain(ACCESS);
    }
  });
});
