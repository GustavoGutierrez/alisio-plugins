import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import type {
  CommandOptions,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, {
  buildAuthorizationUrl,
  COMMAND_NAMES,
  codeChallengeS256,
  createGoogleChatPlugin,
  createTokenSet,
  DEFAULT_SCOPES,
  frameUntrusted,
  GoogleChatError,
  generateCodeVerifier,
  loadConfig,
  MAX_OUTPUT_CHARS,
  MAX_RESPONSE_BYTES,
  normalizeMessageName,
  normalizeSpace,
  normalizeUserReference,
  parseCallbackUrl,
  parseScopes,
  parseTokenSet,
  parseWebhookUrl,
  resourcePaths,
  runLoopbackAuthorization,
  sanitizeRemoteText,
  serializeTokenSet,
  TOOL_NAMES,
  TokenStore,
  TRUNCATION_MARKER,
  UNTRUSTED_NOTICE,
  WRITE_TOOL_NAMES,
} from "../src/index.js";

const WEBHOOK =
  "https://chat.googleapis.com/v1/spaces/AAAAAAAAAAA/messages?key=test-key&token=test-webhook-secret";
const CLIENT_SECRET = "client-secret-value-do-not-leak";
const ACCESS_TOKEN = "access-token-value-do-not-leak";
const REFRESH_TOKEN = "refresh-token-value-do-not-leak";
const CODE = "authorization-code-value-do-not-leak";

const oauthEnv = {
  GOOGLE_CHAT_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CHAT_CLIENT_SECRET: CLIENT_SECRET,
};

const directories: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "alisio-gchat-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const context = (signal: AbortSignal = AbortSignal.timeout(2_000)): ToolContext => ({
  signal,
  workspace: ".",
  emit() {},
});

const textOf = (result: ToolResult): string => {
  for (const part of result.content) if (part.type === "text") return part.text;
  return "";
};

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers });
const empty = (status = 204): Response => new Response(null, { status });

type Call = { url: string; init: RequestInit };

function createFetcher(handler: (call: Call) => Response | Promise<Response>): {
  fetcher: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function requestBody(call: Call): string {
  const raw = call.init.body;
  return typeof raw === "string" ? raw : "";
}

function jsonBody(call: Call): Record<string, unknown> {
  return JSON.parse(requestBody(call)) as Record<string, unknown>;
}

const tool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const found = tools.find((value) => value.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const run = (
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> => tool(tools, name).execute(input, context(signal));

interface Capture {
  api: PluginAPI;
  tools: ToolDefinition[];
  commands: Array<{
    name: string;
    handler: (args: string, ctx?: { sessionId?: string }) => Promise<string>;
    options?: CommandOptions;
  }>;
  skills: string[];
}

function captureApi(): Capture {
  const tools: ToolDefinition[] = [];
  const commands: Capture["commands"] = [];
  const skills: string[] = [];
  const api = {
    tools: {
      register(value: ToolDefinition) {
        tools.push(value);
        return () => undefined;
      },
    },
    commands: {
      register(
        name: string,
        handler: (args: string, ctx?: { sessionId?: string }) => Promise<string>,
        options?: CommandOptions,
      ) {
        commands.push({ name, handler, options });
        return () => undefined;
      },
    },
    resources: {
      skills(path: string) {
        skills.push(path);
      },
    },
  } as unknown as PluginAPI;
  return { api, tools, commands, skills };
}

function oauthStore(overrides: Partial<Parameters<typeof createTokenSet>[0]> = {}): TokenStore {
  const store = new TokenStore(join(tempDir(), "token.json"));
  store.write(
    createTokenSet({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiry: Date.now() + 3_600_000,
      scopes: [...DEFAULT_SCOPES],
      tokenType: "Bearer",
      ...overrides,
    }),
  );
  return store;
}

function oauthTools(
  handler: (call: Call) => Response | Promise<Response>,
  options: {
    store?: TokenStore;
    clock?: { now(): number };
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): { tools: ToolDefinition[]; calls: Call[] } {
  const store = options.store ?? oauthStore();
  const { fetcher, calls } = createFetcher(handler);
  const { api, tools } = captureApi();
  createGoogleChatPlugin({
    env: oauthEnv,
    fetcher,
    tokenStore: store,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  }).setup(api);
  return { tools, calls };
}

function webhookTools(handler: (call: Call) => Response | Promise<Response>): {
  tools: ToolDefinition[];
  calls: Call[];
} {
  const { fetcher, calls } = createFetcher(handler);
  const { api, tools } = captureApi();
  createGoogleChatPlugin({ env: { GOOGLE_CHAT_WEBHOOK_URL: WEBHOOK }, fetcher }).setup(api);
  return { tools, calls };
}

// ---------------------------------------------------------------------------
// Registration, names, effects, schemas
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers every declared tool, the skill, and the two commands", () => {
    const { api, tools, commands, skills } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, tokenStore: oauthStore() }).setup(api);
    expect(tools.map((value) => value.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(TOOL_NAMES.length);
    expect(skills).toEqual([resourcePaths.skills]);
    expect(commands.map((value) => value.name)).toEqual([...COMMAND_NAMES]);
  });

  it("assigns read tools the external effect and mutations the write effect", () => {
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, tokenStore: oauthStore() }).setup(api);
    for (const value of tools)
      expect(value.effect).toBe(
        WRITE_TOOL_NAMES.includes(value.name as never) ? "write" : "external",
      );
  });

  it("uses closed object schemas with declared required fields", () => {
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, tokenStore: oauthStore() }).setup(api);
    for (const value of tools) {
      const schema = value.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, unknown>;
      for (const required of (schema.required as string[] | undefined) ?? [])
        expect(Object.keys(properties)).toContain(required);
    }
  });

  it("defines the plugin identity and categories", () => {
    expect(plugin.id).toBe("google-chat");
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.categories).toEqual(["tools"]);
  });

  it("fails closed when only one OAuth credential is set", () => {
    const { api } = captureApi();
    expect(() =>
      createGoogleChatPlugin({ env: { GOOGLE_CHAT_CLIENT_ID: "only-id" } }).setup(api),
    ).toThrowError(/must be set together/);
  });

  it("loads with no configuration and reports the none mode", async () => {
    const { api, tools } = captureApi();
    const { fetcher, calls } = createFetcher(() => json({}));
    createGoogleChatPlugin({ env: {}, fetcher }).setup(api);
    expect(loadConfig({}).webhook).toBeUndefined();
    expect(loadConfig({}).oauth).toBeUndefined();
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toMatch(/configuration missing or invalid/);
    expect(calls).toHaveLength(0);
  });

  it("documents the host-namespaced command form", () => {
    expect(COMMAND_NAMES.map((name) => `google-chat:${name}`)).toContain("google-chat:auth");
    expect(COMMAND_NAMES.map((name) => `google-chat:${name}`)).toContain("google-chat:status");
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("parses a webhook URL into a validated target", () => {
    const config = loadConfig({ GOOGLE_CHAT_WEBHOOK_URL: WEBHOOK });
    expect(config.webhook?.space).toBe("spaces/AAAAAAAAAAA");
    expect(config.webhook?.hasKey).toBe(true);
    expect(config.webhook?.hasToken).toBe(true);
    expect(config.oauth).toBeUndefined();
    expect(config.webhook?.url).toContain("token=test-webhook-secret");
  });

  it("parses OAuth credentials with default scopes and a token file", () => {
    const config = loadConfig(oauthEnv);
    expect(config.oauth?.clientId).toBe(oauthEnv.GOOGLE_CHAT_CLIENT_ID);
    expect(config.oauth?.clientSecret).toBe(CLIENT_SECRET);
    expect(config.oauth?.scopes).toEqual([...DEFAULT_SCOPES]);
    expect(config.oauth?.tokenFile.endsWith(join("google-chat", "token.json"))).toBe(true);
    expect(config.webhook).toBeUndefined();
  });

  it.each([
    ["http", "http://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t"],
    ["wrong host", "https://example.com/v1/spaces/A/messages?key=k&token=t"],
    ["embedded credentials", "https://u:p@chat.googleapis.com/v1/spaces/A/messages?key=k&token=t"],
    ["wrong path", "https://chat.googleapis.com/v1/spaces/A/members?key=k&token=t"],
    ["missing key", "https://chat.googleapis.com/v1/spaces/A/messages?token=t"],
    ["missing token", "https://chat.googleapis.com/v1/spaces/A/messages?key=k"],
    ["unknown param", "https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t&x=1"],
    ["fragment", "https://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t#frag"],
    ["relative", "not-a-url"],
  ])("rejects a %s webhook URL", (_label, value) => {
    expect(() => loadConfig({ GOOGLE_CHAT_WEBHOOK_URL: value })).toThrowError(
      /configuration missing or invalid/,
    );
    expect(() => parseWebhookUrl(value)).toThrowError(GoogleChatError);
  });

  it("accepts and validates custom Chat scopes only", () => {
    const scopes = parseScopes(
      "https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces.readonly",
    );
    expect(scopes).toHaveLength(2);
    expect(() => parseScopes("https://www.googleapis.com/auth/drive")).toThrowError(/chat/i);
  });

  it("resolves the token file from overrides and the config home", () => {
    const config = loadConfig({
      ...oauthEnv,
      GOOGLE_CHAT_TOKEN_FILE: "/tmp/gchat-token.json",
    });
    expect(config.oauth?.tokenFile).toBe("/tmp/gchat-token.json");
    const fromHome = loadConfig({ ...oauthEnv, ALISIO_CONFIG_HOME: "/custom/config" });
    expect(fromHome.oauth?.tokenFile).toBe(join("/custom/config", "google-chat", "token.json"));
  });

  it("bounds the auth timeout", () => {
    expect(loadConfig(oauthEnv).authTimeoutMs).toBe(300_000);
    expect(() => loadConfig({ ...oauthEnv, GOOGLE_CHAT_AUTH_TIMEOUT_MS: "1" })).toThrowError(
      /between/,
    );
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("secrets", () => {
  it("never serializes the client secret or the webhook token", () => {
    const config = loadConfig({ ...oauthEnv, GOOGLE_CHAT_WEBHOOK_URL: WEBHOOK });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain("test-webhook-secret");
    const printed = inspect(config, { depth: 8 });
    expect(printed).not.toContain(CLIENT_SECRET);
    expect(printed).not.toContain("test-webhook-secret");
  });

  it("never serializes access or refresh tokens", () => {
    const token = createTokenSet({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiry: 123,
      scopes: ["https://www.googleapis.com/auth/chat.messages"],
      tokenType: "Bearer",
    });
    expect(JSON.stringify(token)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(token)).not.toContain(REFRESH_TOKEN);
    expect(inspect(token, { depth: 6 })).not.toContain(ACCESS_TOKEN);
    expect(inspect(token, { depth: 6 })).not.toContain(REFRESH_TOKEN);
    // Only the explicit on-disk serializer writes token material.
    expect(serializeTokenSet(token)).toContain(ACCESS_TOKEN);
    expect(serializeTokenSet(token)).toContain(REFRESH_TOKEN);
  });

  it("never returns a token or secret in a tool result or error", async () => {
    const store = oauthStore();
    const { tools } = oauthTools(() => json({ name: "spaces/A/messages/M", text: "hi" }), {
      store,
    });
    const ok = await run(tools, "google_chat_list_messages", { space: "A" });
    expect(textOf(ok)).not.toContain(ACCESS_TOKEN);
    expect(textOf(ok)).not.toContain(CLIENT_SECRET);

    const failing = oauthTools(() => empty(401), { store });
    const error = await run(failing.tools, "google_chat_list_messages", { space: "A" });
    expect(error.isError).toBe(true);
    expect(textOf(error)).not.toContain(ACCESS_TOKEN);
  });

  it("reports status without printing any secret", async () => {
    const { api, commands } = captureApi();
    createGoogleChatPlugin({
      env: { ...oauthEnv, GOOGLE_CHAT_WEBHOOK_URL: WEBHOOK },
      tokenStore: oauthStore(),
    }).setup(api);
    const status = commands.find((value) => value.name === "status");
    const output = (await status?.handler("")) ?? "";
    expect(output).toContain("Active mode: oauth");
    expect(output).not.toContain(CLIENT_SECRET);
    expect(output).not.toContain(ACCESS_TOKEN);
    expect(output).not.toContain("test-webhook-secret");
    expect(output).toContain("Capabilities:");
  });
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe("capability gating", () => {
  it("refuses reads, edits, and deletes in webhook mode without any network call", async () => {
    const { tools, calls } = webhookTools(() => {
      throw new Error("network must not be reached");
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["google_chat_list_spaces", {}],
      ["google_chat_list_messages", { space: "A" }],
      ["google_chat_search_messages", { query: "hello" }],
      ["google_chat_list_memberships", { space: "A" }],
      ["google_chat_edit_message", { message: "spaces/A/messages/M", text: "new" }],
      ["google_chat_delete_message", { message: "spaces/A/messages/M" }],
    ];
    for (const [name, input] of cases) {
      const result = await run(tools, name, input);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/requires OAuth user mode/);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends through the webhook and reports the mode without any auth", async () => {
    const { tools, calls } = webhookTools(() => json({ name: "spaces/A/messages/M" }, 200));
    const result = await run(tools, "google_chat_send_message", { text: "hi" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Sent via webhook");
    expect(calls).toHaveLength(1);
    const first = calls[0] as Call;
    expect(first.url).toContain("test-key");
    expect(first.url).toContain("token=test-webhook-secret");
    expect((first.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("refuses a webhook send to a different space", async () => {
    const { tools, calls } = webhookTools(() => json({}));
    const result = await run(tools, "google_chat_send_message", { space: "B", text: "hi" });
    expect(textOf(result)).toMatch(/only posts to spaces\/AAAAAAAAAAA/);
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear message when neither mode is configured", async () => {
    const { fetcher, calls } = createFetcher(() => json({}));
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: {}, fetcher }).setup(api);
    const read = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(read)).toMatch(/configuration missing or invalid/);
    const send = await run(tools, "google_chat_send_message", { text: "hi" });
    expect(textOf(send)).toMatch(/configuration missing or invalid/);
    expect(calls).toHaveLength(0);
  });

  it("fails with not authenticated when OAuth is configured without stored tokens", async () => {
    const { fetcher, calls } = createFetcher(() => json({}));
    const { api, tools } = captureApi();
    createGoogleChatPlugin({
      env: oauthEnv,
      fetcher,
      tokenStore: new TokenStore(join(tempDir(), "absent.json")),
    }).setup(api);
    const read = await run(tools, "google_chat_list_spaces", {});
    expect(read.isError).toBe(true);
    expect(textOf(read)).toMatch(/^not authenticated/);
    const send = await run(tools, "google_chat_send_message", { text: "hi" });
    expect(textOf(send)).toMatch(/^not authenticated/);
    expect(calls).toHaveLength(0);
  });

  it("prefers the OAuth identity for sending when a token is stored", async () => {
    const { tools, calls } = oauthTools(() => json({ name: "spaces/A/messages/M" }));
    const result = await run(tools, "google_chat_send_message", { space: "A", text: "hi" });
    expect(textOf(result)).toContain("Sent via oauth");
    expect(calls[0]?.url.startsWith("https://chat.googleapis.com/v1/spaces/A/messages")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation and normalization
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("normalizes spaces, message names, and user references", () => {
    expect(normalizeSpace("AAAA")).toBe("spaces/AAAA");
    expect(normalizeSpace("spaces/AAAA")).toBe("spaces/AAAA");
    expect(() => normalizeSpace("bad space")).toThrowError(/^invalid input/);
    expect(normalizeMessageName("spaces/A/messages/M.1")).toBe("spaces/A/messages/M.1");
    expect(() => normalizeMessageName("spaces/A")).toThrowError(/^invalid input/);
    expect(normalizeUserReference("alice@example.com")).toBe("users/alice@example.com");
    expect(normalizeUserReference("@alice@example.com")).toBe("users/alice@example.com");
    expect(normalizeUserReference("users/12345")).toBe("users/12345");
    expect(normalizeUserReference("@me")).toBe("users/me");
    expect(() => normalizeUserReference("not a user!")).toThrowError(/^invalid input/);
  });

  it("accepts a username without a leading @ in a search sender filter", async () => {
    const { tools, calls } = oauthTools(() => json({ results: [] }));
    await run(tools, "google_chat_search_messages", {
      query: "deploy failed",
      sender: "alice@example.com",
    });
    const body = jsonBody(calls[0] as Call);
    expect(body.filter).toBe('sender.name = "users/alice@example.com" AND deploy failed');
  });

  it("strips a leading @ from the sender filter", async () => {
    const { tools, calls } = oauthTools(() => json({ results: [] }));
    await run(tools, "google_chat_search_messages", { query: "hi", sender: "@bob@example.com" });
    expect(jsonBody(calls[0] as Call).filter).toBe('sender.name = "users/bob@example.com" AND hi');
  });

  it("rejects unknown fields and oversized text without a request", async () => {
    const { tools, calls } = oauthTools(() => json({}));
    const unknown = await run(tools, "google_chat_list_messages", { space: "A", extra: 1 });
    expect(textOf(unknown)).toMatch(/unknown field/);
    const oversized = await run(tools, "google_chat_send_message", {
      space: "A",
      text: "x".repeat(32_001),
    });
    expect(textOf(oversized)).toMatch(/32000-byte/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a client message id in webhook mode", async () => {
    const { tools, calls } = webhookTools(() => json({}));
    const result = await run(tools, "google_chat_send_message", {
      text: "hi",
      messageId: "client-abc",
    });
    expect(textOf(result)).toMatch(/require OAuth user mode/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OAuth URL, PKCE, callback
// ---------------------------------------------------------------------------

describe("oauth flow primitives", () => {
  it("builds a PKCE authorization URL with the required scopes", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const challenge = codeChallengeS256(verifier);
    expect(challenge).toBe(codeChallengeS256(verifier));
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-id.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:5555",
        scopes: [...DEFAULT_SCOPES],
        state: "state-1",
        codeChallenge: challenge,
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")).toContain("chat.messages");
    expect(url.searchParams.get("scope")).toContain("chat.spaces.readonly");
  });

  it("accepts a matching callback and rejects wrong or absent state", () => {
    expect(parseCallbackUrl("/?code=abc&state=good", "good")).toBe("abc");
    expect(() => parseCallbackUrl("/?code=abc&state=bad", "good")).toThrowError(
      /state did not match/,
    );
    expect(() => parseCallbackUrl("/?code=abc", "good")).toThrowError(/state did not match/);
    expect(() => parseCallbackUrl("/?state=good", "good")).toThrowError(/code was absent/);
    expect(() => parseCallbackUrl("/?error=access_denied&state=good", "good")).toThrowError(
      /denied or failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// Token store, exchange, refresh
// ---------------------------------------------------------------------------

describe("token store", () => {
  it("persists atomically with 0600 and a 0700 parent", () => {
    const path = join(tempDir(), "nested", "google-chat", "token.json");
    const store = new TokenStore(path);
    store.write(
      createTokenSet({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiry: 1_000,
        scopes: [...DEFAULT_SCOPES],
        tokenType: "Bearer",
      }),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const loaded = store.read();
    expect(loaded?.accessToken).toBe(ACCESS_TOKEN);
    expect(loaded?.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("validates a malformed token file without echoing it", () => {
    const path = join(tempDir(), "token.json");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const store = new TokenStore(path);
    expect(() => store.read()).toThrowError(/not valid JSON/);
    expect(() => parseTokenSet({ accessToken: 5 })).toThrowError(/no access token/);
  });
});

describe("token exchange and refresh", () => {
  it("refreshes once on 401 and retries the request exactly once", async () => {
    const store = oauthStore();
    const calls: Call[] = [];
    let chatCalls = 0;
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("https://chat.googleapis.com")) {
        chatCalls += 1;
        return chatCalls === 1 ? empty(401) : json({ spaces: [], nextPageToken: "next" });
      }
      return json({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/chat.messages",
        token_type: "Bearer",
      });
    }) as unknown as typeof fetch;

    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, fetcher: routed, tokenStore: store }).setup(api);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(result.isError).toBeUndefined();
    expect(chatCalls).toBe(2);
    const tokenCalls = calls.filter((call) => call.url === "https://oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(1);
    expect(store.read()?.accessToken).toBe("fresh-access");
  });

  it("stops after one refresh when the retry is still 401", async () => {
    const store = oauthStore();
    const { fetcher, calls } = createFetcher((call) => {
      if (call.url === "https://oauth2.googleapis.com/token")
        return json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      return empty(401);
    });
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, fetcher, tokenStore: store }).setup(api);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toBe("not authenticated");
    expect(calls.filter((call) => call.url.startsWith("https://chat.googleapis.com"))).toHaveLength(
      2,
    );
    expect(calls.filter((call) => call.url === "https://oauth2.googleapis.com/token")).toHaveLength(
      1,
    );
  });

  it("refreshes proactively when the stored token is expired", async () => {
    const store = oauthStore({ expiry: Date.now() - 1_000 });
    const { fetcher, calls } = createFetcher(() =>
      json({ access_token: "fresh-access", expires_in: 3600, token_type: "Bearer" }),
    );
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, fetcher, tokenStore: store }).setup(api);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(store.read()?.accessToken).toBe("fresh-access");
    expect(store.read()?.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("clears the store and reports not authenticated when refresh is revoked", async () => {
    const path = join(tempDir(), "token.json");
    const store = new TokenStore(path);
    store.write(
      createTokenSet({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiry: Date.now() - 1_000,
        scopes: [...DEFAULT_SCOPES],
        tokenType: "Bearer",
      }),
    );
    const { fetcher, calls } = createFetcher(() => json({ error: "invalid_grant" }, 400));
    const { api, tools } = captureApi();
    createGoogleChatPlugin({ env: oauthEnv, fetcher, tokenStore: store }).setup(api);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toMatch(/^not authenticated/);
    expect(textOf(result)).toMatch(/google-chat-auth/);
    expect(textOf(result)).not.toContain(REFRESH_TOKEN);
    expect(store.read()).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loopback authorization
// ---------------------------------------------------------------------------

describe("loopback authorization", () => {
  const oauthConfig = (): NonNullable<ReturnType<typeof loadConfig>["oauth"]> => {
    const oauth = loadConfig(oauthEnv).oauth;
    if (!oauth) throw new Error("missing oauth config");
    return oauth;
  };

  it("runs the full flow, persists nothing itself, and never returns the code or tokens", async () => {
    let authorizationUrl = "";
    let resolveUrl!: () => void;
    const urlReady = new Promise<void>((resolve) => {
      resolveUrl = resolve;
    });
    const { fetcher, calls } = createFetcher((call) => {
      expect(call.url).toBe("https://oauth2.googleapis.com/token");
      return json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/chat.messages",
        token_type: "Bearer",
      });
    });
    const pending = runLoopbackAuthorization({
      config: oauthConfig(),
      fetcher,
      timeoutMs: 5_000,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
        resolveUrl();
      },
    });
    await urlReady;
    const parsed = new URL(authorizationUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
    const state = parsed.searchParams.get("state") ?? "";
    expect(redirectUri.startsWith("http://127.0.0.1:")).toBe(true);
    const callback = await fetch(`${redirectUri}/?code=${CODE}&state=${state}`);
    expect(callback.status).toBe(200);

    const result = await pending;
    expect(result.token.accessToken).toBe(ACCESS_TOKEN);
    const exchange = requestBody(calls[0] as Call);
    expect(exchange).toContain("grant_type=authorization_code");
    expect(exchange).toContain("code_verifier");
    expect(exchange).toContain("redirect_uri");
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);

    // The listener is closed after the flow.
    await expect(fetch(redirectUri, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  });

  it("rejects a callback whose state does not match", async () => {
    let authorizationUrl = "";
    let resolveUrl!: () => void;
    const urlReady = new Promise<void>((resolve) => {
      resolveUrl = resolve;
    });
    const { fetcher } = createFetcher(() => json({}));
    const pending = runLoopbackAuthorization({
      config: oauthConfig(),
      fetcher,
      timeoutMs: 5_000,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
        resolveUrl();
      },
    });
    await urlReady;
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "";
    const callbackPromise = fetch(`${redirectUri}/?code=${CODE}&state=wrong`);
    await expect(pending).rejects.toThrow(/state did not match/);
    const callback = await callbackPromise;
    expect(callback.status).toBe(400);
  });

  it("times out and cleans up the listener", async () => {
    let authorizationUrl = "";
    let resolveUrl!: () => void;
    const urlReady = new Promise<void>((resolve) => {
      resolveUrl = resolve;
    });
    const { fetcher } = createFetcher(() => json({}));
    const pending = runLoopbackAuthorization({
      config: oauthConfig(),
      fetcher,
      timeoutMs: 60,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
        resolveUrl();
      },
    });
    await urlReady;
    await expect(pending).rejects.toThrow(/timed out/);
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "";
    await expect(fetch(redirectUri, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

describe("request shapes", () => {
  it("lists messages with paging, filter, and ordering", async () => {
    const { tools, calls } = oauthTools(() =>
      json({
        messages: [{ name: "spaces/A/messages/M1", text: "hello", sender: { displayName: "Ada" } }],
        nextPageToken: "next",
      }),
    );
    const result = await run(tools, "google_chat_list_messages", {
      space: "A",
      pageSize: 10,
      filter: 'createTime > "2024-01-01T00:00:00Z"',
      orderBy: "createTime DESC",
      showDeleted: true,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin).toBe("https://chat.googleapis.com");
    expect(url.pathname).toBe("/v1/spaces/A/messages");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get("orderBy")).toBe("createTime DESC");
    expect(url.searchParams.get("showDeleted")).toBe("true");
    expect(textOf(result)).toContain("spaces/A/messages/M1");
    expect(textOf(result)).toContain("Ada");
    expect(textOf(result)).toContain("next");
  });

  it("posts to the search endpoint with the user-auth path", async () => {
    const { tools, calls } = oauthTools(() => json({ results: [] }));
    await run(tools, "google_chat_search_messages", {
      query: "incident",
      pageSize: 5,
      orderBy: "createTime desc",
      view: "SEARCH_MESSAGES_VIEW_FULL",
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/spaces/-/messages:search");
    expect(calls[0]?.init.method).toBe("POST");
    expect(jsonBody(calls[0] as Call)).toMatchObject({
      filter: "incident",
      pageSize: 5,
      orderBy: "createTime desc",
      view: "SEARCH_MESSAGES_VIEW_FULL",
    });
  });

  it("lists memberships with a role and member-type filter", async () => {
    const { tools, calls } = oauthTools(() => json({ memberships: [] }));
    await run(tools, "google_chat_list_memberships", {
      space: "spaces/A",
      role: "ROLE_MANAGER",
      memberType: "HUMAN",
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/spaces/A/members");
    expect(url.searchParams.get("filter")).toBe('role = "ROLE_MANAGER" AND member.type = "HUMAN"');
  });

  it("lists spaces with a space-type filter", async () => {
    const { tools, calls } = oauthTools(() => json({ spaces: [] }));
    await run(tools, "google_chat_list_spaces", { spaceType: "GROUP_CHAT" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/spaces");
    expect(url.searchParams.get("filter")).toBe('spaceType = "GROUP_CHAT"');
  });

  it("sends a threaded message with a reply option and client id", async () => {
    const { tools, calls } = oauthTools(() => json({ name: "spaces/A/messages/M" }));
    await run(tools, "google_chat_send_message", {
      space: "A",
      text: "status update",
      threadKey: "THREAD-1",
      replyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      messageId: "client-status-1",
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/spaces/A/messages");
    expect(url.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(url.searchParams.get("messageId")).toBe("client-status-1");
    expect(jsonBody(calls[0] as Call)).toEqual({
      text: "status update",
      thread: { threadKey: "THREAD-1" },
    });
  });

  it("edits a message with the required updateMask=text and a text-only body", async () => {
    const { tools, calls } = oauthTools(() =>
      json({ name: "spaces/A/messages/M", text: "fixed", lastUpdateTime: "2026-01-01T00:00:00Z" }),
    );
    const result = await run(tools, "google_chat_edit_message", {
      message: "spaces/A/messages/M",
      text: "fixed",
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(url.pathname).toBe("/v1/spaces/A/messages/M");
    expect(url.searchParams.get("updateMask")).toBe("text");
    expect(jsonBody(calls[0] as Call)).toEqual({ text: "fixed" });
    expect(textOf(result)).toContain("Edited message");
  });

  it("deletes a message with DELETE", async () => {
    const { tools, calls } = oauthTools(() => empty());
    const result = await run(tools, "google_chat_delete_message", {
      message: "spaces/A/messages/M",
    });
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/spaces/A/messages/M");
    expect(textOf(result)).toBe("Deleted spaces/A/messages/M.");
  });

  it("bounds the returned message count", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      name: `spaces/A/messages/M${index}`,
      text: `m${index}`,
    }));
    const { tools } = oauthTools(() => json({ messages }));
    const result = await run(tools, "google_chat_list_messages", { space: "A" });
    expect(textOf(result)).toContain("5 more not shown");
    expect((textOf(result).match(/^- spaces/gm) ?? []).length).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// HTTP safety
// ---------------------------------------------------------------------------

describe("http safety", () => {
  it("refuses redirects and never follows them", async () => {
    const redirect = {
      status: 200,
      redirected: true,
      url: "",
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const { tools, calls } = oauthTools(() => redirect);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toMatch(/^invalid response/);
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("rejects a response larger than the hard cap", async () => {
    const oversized = new Response("x".repeat(MAX_RESPONSE_BYTES + 128), { status: 200 });
    const { tools } = oauthTools(() => oversized);
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toBe("response exceeded limit");
  });

  it("propagates aborts through the combined signal", async () => {
    const controller = new AbortController();
    let combined: AbortSignal | undefined;
    const { api, tools } = captureApi();
    const { fetcher } = createFetcher((call) => {
      combined = call.init.signal as AbortSignal;
      if (combined.aborted)
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return new Promise<Response>((_resolve, reject) => {
        call.init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    createGoogleChatPlugin({ env: oauthEnv, fetcher, tokenStore: oauthStore() }).setup(api);
    const pending = run(tools, "google_chat_list_spaces", {}, controller.signal);
    controller.abort();
    const result = await pending;
    expect(textOf(result)).toBe("temporarily unavailable");
    expect(combined?.aborted).toBe(true);
  });

  it("maps status codes to the safe vocabulary", async () => {
    const cases: Array<[number, string]> = [
      [401, "not authenticated"],
      [403, "not permitted"],
      [404, "not found"],
      [400, "invalid input"],
      [500, "temporarily unavailable"],
    ];
    for (const [status, expected] of cases) {
      const { tools } = oauthTools(() => empty(status));
      const result = await run(tools, "google_chat_list_spaces", {});
      expect(textOf(result).startsWith(expected)).toBe(true);
    }
  });

  it("maps 403 before existence with an explicit note", async () => {
    const { tools } = oauthTools(() => empty(403));
    const result = await run(tools, "google_chat_list_messages", { space: "A" });
    expect(textOf(result)).toMatch(/^not permitted/);
    expect(textOf(result)).toMatch(/before confirming whether they exist/);
  });

  it("backs off a read on 429 honouring Retry-After", async () => {
    const delays: number[] = [];
    let calls = 0;
    const { tools } = oauthTools(
      () => {
        calls += 1;
        return calls === 1 ? json({}, 429, { "retry-after": "2" }) : json({ spaces: [] });
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it("surfaces a bounded Retry-After and never retries a mutation", async () => {
    const delays: number[] = [];
    const { tools, calls } = oauthTools(() => json({}, 429, { "retry-after": "45" }), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const result = await run(tools, "google_chat_send_message", { space: "A", text: "hi" });
    expect(textOf(result)).toBe("rate limited: retry after 45 seconds");
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it("caps an HTTP-date Retry-After with the injected clock", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const retryAt = new Date(now + 60_000).toUTCString();
    const delays: number[] = [];
    const { tools } = oauthTools(() => json({}, 503, { "retry-after": retryAt }), {
      clock: { now: () => now },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const result = await run(tools, "google_chat_list_spaces", {});
    expect(textOf(result)).toBe("temporarily unavailable: retry after 60 seconds");
    expect(delays).toEqual([8_000, 8_000]);
  });
});

// ---------------------------------------------------------------------------
// Untrusted content
// ---------------------------------------------------------------------------

describe("untrusted content", () => {
  it("normalizes control characters and neutralizes Markdown", () => {
    const dirty = "# Heading\u0000\u0007 [link](https://x) *bold* <script>";
    const clean = sanitizeRemoteText(dirty);
    expect(clean).not.toContain("\u0000");
    expect(clean).not.toContain("\u0007");
    expect(clean).toContain("\\# Heading");
    expect(clean).toContain("\\[link\\]");
    expect(clean).not.toContain("<script>");
    expect(clean).toContain("&lt;script&gt;");
    expect(clean).toContain("\\*bold\\*");
  });

  it("frames messages and clamps the aggregate", async () => {
    const long = "a".repeat(50_000);
    const { tools } = oauthTools(() =>
      json({ messages: [{ name: "spaces/A/messages/M", text: long }] }),
    );
    const result = await run(tools, "google_chat_list_messages", { space: "A" });
    const value = textOf(result);
    expect(value.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(value.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(value).toContain(TRUNCATION_MARKER);
  });

  it("clamps each field deterministically", () => {
    const clean = sanitizeRemoteText("b".repeat(100), 40);
    expect(clean.length).toBe(40);
    expect(clean.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(sanitizeRemoteText("b".repeat(100), 4).length).toBeLessThanOrEqual(4);
  });

  it("frames a shared report body", () => {
    const framed = frameUntrusted("Message: spaces/A/messages/M");
    expect(framed.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(framed).toContain("Message: spaces/A/messages/M");
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe("commands", () => {
  it("reports the webhook mode and its send-only capability", async () => {
    const { api, commands, skills } = captureApi();
    createGoogleChatPlugin({ env: { GOOGLE_CHAT_WEBHOOK_URL: WEBHOOK } }).setup(api);
    expect(skills).toEqual([resourcePaths.skills]);
    const status = commands.find((value) => value.name === "status");
    const output = (await status?.handler("")) ?? "";
    expect(output).toContain("Active mode: webhook");
    expect(output).toContain("Send messages: yes");
    expect(output).toContain("List spaces, messages, and memberships; search messages: no");
    expect(output).not.toContain("test-webhook-secret");
  });

  it("explains that auth needs OAuth mode without binding a listener", async () => {
    const { api, commands } = captureApi();
    createGoogleChatPlugin({ env: {} }).setup(api);
    const auth = commands.find((value) => value.name === "auth");
    const output = (await auth?.handler("")) ?? "";
    expect(output).toMatch(/requires OAuth user mode/);
  });

  it("reports an unusable token file without leaking it", async () => {
    const path = join(tempDir(), "token.json");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const { api, commands } = captureApi();
    createGoogleChatPlugin({
      env: oauthEnv,
      tokenStore: new TokenStore(path),
    }).setup(api);
    const status = commands.find((value) => value.name === "status");
    const output = (await status?.handler("")) ?? "";
    expect(output).toContain("OAuth tokens: unusable");
    expect(output).not.toContain(CLIENT_SECRET);
  });
});
