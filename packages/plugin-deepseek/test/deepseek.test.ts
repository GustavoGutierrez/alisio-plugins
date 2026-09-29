import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import type { ModelProvider, Plugin, ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekPlugin, DeepSeekProvider } from "../src/index.js";

const openAiClient = (client: unknown) => client as unknown as OpenAI;

const request = (model: string) => ({
  instructions: "system",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [
    {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      async execute() {
        return { content: [] };
      },
    },
  ],
  maxOutputTokens: 128,
  signal: AbortSignal.timeout(5000),
  model,
});

const collect = async (provider: ModelProvider, model: string) => {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request(model))) events.push(event);
  return events;
};

const registration = (plugin: Plugin): ProviderRegistration => {
  let found: ProviderRegistration | undefined;
  plugin.setup({
    providers: {
      register(value: ProviderRegistration) {
        found = value;
        return () => {};
      },
    },
  } as unknown as Parameters<Plugin["setup"]>[0]);
  if (!found) throw new Error("provider was not registered");
  return found;
};

const deepseek = (client: unknown, apiMode: "chat" | "responses" = "chat") =>
  new DeepSeekProvider(
    {
      baseURL: "https://api.deepseek.com",
      apiKey: "fake",
      apiKeyEnv: "UNUSED",
      model: "fixture",
      apiMode,
      auth: "bearer",
      tokenParameter: "max_tokens",
      streamUsage: false,
    },
    openAiClient(client),
  );

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

/** Minimal Web Request/Response bridge over node:http (no external dependencies). */
async function serve(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ port: number; close(): Promise<void> }> {
  let port = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("DeepSeek plugin registration", () => {
  it("registers masked credentials and provider-specific defaults", () => {
    const value = registration(createDeepSeekPlugin());
    expect(value.id).toBe("deepseek");
    expect(value.fields.find((field) => field.key === "apiKey")).toMatchObject({
      kind: "secret",
      required: true,
    });
    expect(value.fields.find((field) => field.key === "baseURL")?.defaultValue).toBe(
      "https://api.deepseek.com",
    );
  });

  it("registers the configurable API key environment variable with the plugin default", () => {
    const value = registration(createDeepSeekPlugin());
    expect(value.fields.find((field) => field.key === "apiKeyEnv")?.kind).toBe("text");
    expect(value.fields.find((field) => field.key === "apiKeyEnv")?.required).not.toBe(true);
    expect(value.fields.find((field) => field.key === "apiKeyEnv")?.defaultValue).toBe(
      "DEEPSEEK_API_KEY",
    );
  });

  it("resolves the apiKeyEnv name from the profile and falls back to the plugin default", () => {
    vi.stubEnv("MY_CUSTOM_API_KEY_VAR", "fake-custom-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const profiled = registration(createDeepSeekPlugin()).create({
      profile: { apiKeyEnv: "MY_CUSTOM_API_KEY_VAR" },
      credentials: {},
    } as never) as ModelProvider;
    // Construction succeeds only when the resolved env name (the profile's) is consulted:
    // the plugin default DEEPSEEK_API_KEY is empty, so any fallback to it would throw.
    expect(profiled.id).toBe("deepseek:chat:https://api.deepseek.com");

    // When the profile names a var that is unset, the default env var does NOT rescue it.
    vi.stubEnv("MY_CUSTOM_API_KEY_VAR", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-default-key");
    expect(() =>
      registration(createDeepSeekPlugin()).create({
        profile: { apiKeyEnv: "MY_CUSTOM_API_KEY_VAR" },
        credentials: {},
      } as never),
    ).toThrow(/MY_CUSTOM_API_KEY_VAR/);
  });

  it("with no profile apiKeyEnv, falls back to the plugin default env name", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-default-key");
    const provider = registration(createDeepSeekPlugin()).create({
      profile: {},
      credentials: {},
    } as never) as ModelProvider;
    expect(provider.id).toBe("deepseek:chat:https://api.deepseek.com");
  });

  it("with a stored credential, never consults any environment variable", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const provider = registration(createDeepSeekPlugin()).create({
      profile: {},
      credentials: { apiKey: "fake-stored-key" },
    } as never) as ModelProvider;
    expect(provider.id).toBe("deepseek:chat:https://api.deepseek.com");
    expect(JSON.stringify(provider)).not.toContain("fake-stored-key");
    expect(inspect(provider, { showHidden: true, depth: 8 })).not.toContain("fake-stored-key");
  });
});

describe("DeepSeek provider", () => {
  it("parses the exact official catalog metadata shape", async () => {
    const fakeKey = "fake-deepseek-key";
    const client = {
      models: {
        async *list() {
          yield {
            id: "deepseek-flash",
            object: "model",
            owned_by: "deepseek",
            name: "Flash",
            context_window: 1000000,
            max_output_tokens: 64000,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            api_capabilities: {
              anthropic_messages: { system_prompt_update: "in-history" },
            },
            effort: { supported_levels: ["low", "high"], default_level: "high" },
          };
        },
      },
    };
    const provider = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: fakeKey,
        apiKeyEnv: "UNUSED",
        model: "deepseek-flash",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      openAiClient(client),
    );
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      {
        id: "deepseek-flash",
        ownedBy: "deepseek",
        name: "Flash",
        contextWindow: 1000000,
        maxOutputTokens: 64000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        apiCapabilities: {
          anthropic_messages: { system_prompt_update: "in-history" },
        },
        effort: { supportedLevels: ["low", "high"], defaultLevel: "high" },
      },
    ]);
    expect(JSON.stringify(provider)).not.toContain(fakeKey);
  });

  it.each(["chat", "responses"] as const)(
    "streams tools and continuation in %s mode",
    async (mode) => {
      let calls = 0;
      const client = {
        models: { async *list() {} },
        chat: {
          completions: {
            async create() {
              calls++;
              return (async function* () {
                yield {
                  choices: [
                    {
                      delta: {
                        reasoning_content: "think",
                        tool_calls: [
                          { index: 0, id: "call-1", function: { name: "echo", arguments: "{}" } },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                };
              })();
            },
          },
        },
        responses: {
          async create() {
            calls++;
            return (async function* () {
              yield {
                type: "response.completed",
                response: {
                  output: [
                    { type: "function_call", call_id: "call-1", name: "echo", arguments: "{}" },
                  ],
                },
              };
            })();
          },
        },
      };
      const provider = new DeepSeekProvider(
        {
          baseURL: "https://api.deepseek.com",
          apiKey: "fake",
          apiKeyEnv: "UNUSED",
          model: "deepseek-flash",
          apiMode: mode,
          auth: "bearer",
          tokenParameter: "max_tokens",
          streamUsage: true,
        },
        openAiClient(client),
      );
      const events = await collect(provider, "deepseek-flash");
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        message: { calls: [{ id: "call-1", name: "echo", arguments: "{}" }] },
      });
      expect(calls).toBe(1);
    },
  );

  it("emits official Responses reasoning text and supported summary deltas", async () => {
    const client = {
      responses: {
        async create() {
          return (async function* () {
            yield { type: "response.reasoning_text.delta", delta: "private-visible" };
            yield { type: "response.reasoning_summary_text.delta", delta: "summary" };
            yield { type: "response.completed", response: { output: [] } };
          })();
        },
      },
    };
    const provider = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: "fake",
        apiKeyEnv: "UNUSED",
        model: "deepseek-reasoner",
        apiMode: "responses",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      openAiClient(client),
    );
    expect(await collect(provider, "deepseek-reasoner")).toEqual([
      { type: "reasoning_delta", delta: "private-visible" },
      { type: "reasoning_delta", delta: "summary" },
      { type: "completed", message: { role: "assistant", text: "", calls: [], providerData: [] } },
    ]);
  });

  it("hides credentials held by the real OpenAI SDK client", () => {
    const deepSeekKey = "fake-deepseek-inspection-key";
    const provider = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: deepSeekKey,
        apiKeyEnv: "UNUSED",
        model: "deepseek-chat",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      openAiClient({}),
    );
    expect(inspect(provider, { showHidden: true, depth: 8 })).not.toContain(deepSeekKey);
    expect(JSON.stringify(provider)).not.toContain(deepSeekKey);
    expect(Object.keys(provider).map((key) => inspect((provider as never)[key]))).not.toContain(
      expect.stringContaining(deepSeekKey),
    );
  });
});

describe("DeepSeek reasoning effort", () => {
  /** Network-free probe: asserts the request body carries `reasoning_effort` / `reasoning.effort` exactly when set. */
  async function probe(apiMode: "chat" | "responses", reasoningEffort?: string) {
    let body: Record<string, unknown> | undefined;
    const server = await serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      if (!req.url.includes("/chat/completions") && !req.url.includes("/responses"))
        return new Response("not found", { status: 404 });
      if (apiMode === "responses")
        return new Response(
          [
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "r1",
                object: "response",
                created_at: 1,
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return new Response(
        [
          `data: ${JSON.stringify({
            id: "t",
            object: "chat.completion.chunk",
            created: 1,
            model: "deepseek-test",
            choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    try {
      const provider = new DeepSeekProvider({
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKeyEnv: "DEEPSEEK_API_KEY",
        model: "deepseek-test",
        apiMode,
        auth: "none",
        tokenParameter: "max_tokens",
        streamUsage: false,
      });
      const events: string[] = [];
      for await (const event of provider.stream({
        instructions: "test",
        messages: [{ role: "user" as const, text: "hi" }],
        tools: [],
        maxOutputTokens: 128,
        signal: AbortSignal.timeout(5000),
        model: "deepseek-test",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })) {
        if (event.type === "completed" || event.type === "text_delta") events.push(event.type);
      }
      return { body, events };
    } finally {
      await server.close();
    }
  }

  it("sends reasoning_effort in chat mode only when set", async () => {
    const withEffort = await probe("chat", "max");
    expect(withEffort.events).toContain("completed");
    expect(withEffort.body?.reasoning_effort).toBe("max");

    const without = await probe("chat");
    expect(without.body?.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning.effort in responses mode only when set", async () => {
    const withEffort = await probe("responses", "high");
    expect(withEffort.events).toContain("completed");
    expect(withEffort.body?.reasoning).toEqual({ effort: "high" });

    const without = await probe("responses");
    expect(without.body?.reasoning).toBeUndefined();
  });
});

describe("DeepSeek truncation", () => {
  const chatChunk = (text: string, finish_reason: string | null) => ({
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason }],
  });
  const chatClient = (events: unknown[]) => ({
    models: { async *list() {} },
    chat: {
      completions: {
        async create() {
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    },
  });
  const responsesClient = (events: unknown[]) => ({
    responses: {
      async create() {
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  });
  const incomplete = (output: unknown[]) => ({
    type: "response.incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    response: { output },
  });
  const message = (text: string) => [{ type: "message", content: [{ type: "output_text", text }] }];

  it("chat: finish length after text completes truncated", async () => {
    const provider = deepseek(
      chatClient([{ ...chatChunk("partial ", null) }, { ...chatChunk("answer", "length") }]),
    );
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { role: "assistant", text: "partial answer", calls: [], truncated: true },
    });
  });

  it("chat and responses keep throwing on length with nothing usable", async () => {
    const chat = deepseek(chatClient([{ ...chatChunk("", "length") }]));
    await expect(collect(chat, "fixture")).rejects.toThrow(/max output tokens/);
    const responses = deepseek(responsesClient([incomplete([])]), "responses");
    await expect(collect(responses, "fixture")).rejects.toThrow(/max output tokens/);
  });

  it("responses: incomplete after partial text completes truncated", async () => {
    const provider = deepseek(
      responsesClient([incomplete(message("partial answer"))]),
      "responses",
    );
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { role: "assistant", text: "partial answer", calls: [], truncated: true },
    });
  });

  it("responses: incomplete with a partial function call throws", async () => {
    const provider = deepseek(
      responsesClient([
        incomplete([
          ...message("calling"),
          { type: "function_call", call_id: "c1", arguments: '{"x":' },
        ]),
      ]),
      "responses",
    );
    await expect(collect(provider, "fixture")).rejects.toThrow(/Incomplete tool call/);
  });
});
