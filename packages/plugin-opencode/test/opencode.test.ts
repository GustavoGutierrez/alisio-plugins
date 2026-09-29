import { inspect } from "node:util";
import type { ModelProvider, Plugin, ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { classifyOpenCodeModel, createOpenCodePlugin, OpenCodeProvider } from "../src/index.js";

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

const request = (model: string, sessionId = "00000000-0000-4000-8000-000000000001") => ({
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
  sessionId,
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

const openCode = (model: string, fetchMock: typeof fetch) =>
  new OpenCodeProvider({
    apiKey: "fake",
    model,
    baseURL: "http://127.0.0.1/v1",
    fetch: fetchMock,
  });

describe("OpenCode Console plugin registration", () => {
  it("registers separately with a masked API key", () => {
    const value = registration(createOpenCodePlugin());
    expect(value).toMatchObject({ id: "opencode", name: "OpenCode Console (Zen)" });
    expect(value.fields).toEqual([expect.objectContaining({ key: "apiKey", kind: "secret" })]);
  });

  it("hides credentials", () => {
    const zenKey = "fake-zen-inspection-key";
    const provider = new OpenCodeProvider({ apiKey: zenKey, model: "gpt-6-sol" });
    expect(inspect(provider, { showHidden: true, depth: 8 })).not.toContain(zenKey);
    expect(JSON.stringify(provider)).not.toContain(zenKey);
  });

  it.each([
    ["gpt-6-sol", "responses"],
    ["grok-4.7", "responses"],
    ["muse-spark-1.3", "responses"],
    ["deepseek-v4-pro", "chat"],
    ["minimax-m3", "chat"],
    ["qwen3.8-max", "chat"],
    ["qwen3.8-flash", "messages"],
    ["claude-sonnet-5", "messages"],
    ["gemini-3.8-flash", undefined],
    ["jev-1.13", undefined],
    ["future-model", undefined],
  ] as const)("classifies %s as %s", (model, protocol) => {
    expect(classifyOpenCodeModel(model)).toBe(protocol);
  });
});

describe("OpenCode Console provider", () => {
  it("uses an unauthenticated catalog, preserves metadata, and hides unsupported models", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("user-agent")).toBe("alisio/test");
      return Response.json({
        data: [
          {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            context_window: 200000,
            max_output_tokens: 64000,
            modalities: ["text", "image"],
            capabilities: { tools: true },
          },
          { id: "gemini-3.8-flash" },
          { id: "jev-1.13" },
          { id: "future-model" },
        ],
      });
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake-opencode-key",
      model: "",
      baseURL: "http://127.0.0.1/v1",
      userAgent: "alisio/test",
      fetch: fetchMock as typeof fetch,
    });
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      {
        id: "opencode/claude-sonnet-5",
        name: "Claude Sonnet 5",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        modalities: ["text", "image"],
        capabilities: { tools: true },
      },
    ]);
    expect(JSON.stringify(provider)).not.toContain("fake-opencode-key");
  });

  it("generates one opaque stable fallback session id when a caller omits it", async () => {
    const sessionHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sessionHeaders.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "deepseek-v4-pro",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    const withoutSession = { ...request("deepseek-v4-pro"), sessionId: undefined };
    for (let index = 0; index < 2; index++)
      for await (const _ of provider.stream(withoutSession)) void _;
    expect(sessionHeaders[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionHeaders[1]).toBe(sessionHeaders[0]);
  });

  it("keeps explicit OpenCode session headers stable and distinct per child", async () => {
    const sessionHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sessionHeaders.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    const provider = openCode("deepseek-v4-pro", fetchMock as typeof fetch);
    for (const sessionId of ["parent-session", "child-session", "child-session"])
      for await (const _ of provider.stream(request("deepseek-v4-pro", sessionId))) void _;
    expect(sessionHeaders).toEqual(["parent-session", "child-session", "child-session"]);
  });

  it.each([
    [
      "deepseek-v4-pro",
      "/chat/completions",
      [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }],
    ],
    [
      "gpt-6-sol",
      "/responses",
      [
        {
          type: "response.completed",
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          },
        },
      ],
    ],
    [
      "claude-sonnet-5",
      "/messages",
      [
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ],
    ],
  ] as const)("routes %s to %s with required identity headers", async (model, route, events) => {
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fake-opencode-key");
      expect(headers.get("user-agent")).toBe("alisio/test");
      expect(headers.get("x-opencode-session")).toBe(sessionId);
      if (route === "/messages") expect(headers.get("anthropic-version")).toBe("2023-06-01");
      return sse([...events]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake-opencode-key",
      model,
      baseURL: "http://127.0.0.1/v1",
      userAgent: "alisio/test",
      fetch: fetchMock as typeof fetch,
    });
    const result: unknown[] = [];
    for await (const event of provider.stream(request(model, sessionId))) result.push(event);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(route);
    expect(result.at(-1)).toMatchObject({ type: "completed", message: { text: "ok" } });
  });

  it("rejects a protocol change on an existing provider session", async () => {
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "gpt-6-sol",
      baseURL: "http://127.0.0.1/v1",
      fetch: vi.fn() as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of provider.stream(request("deepseek-v4-pro"))) void _;
    }).rejects.toThrow("session is bound to responses");
  });

  it("replays Messages reasoning signatures, tool blocks, results, and image attachments", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: unknown }>;
      };
      calls++;
      if (calls === 1) {
        const content = body.messages[0]?.content as Array<Record<string, unknown>>;
        expect(content[1]).toMatchObject({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QQ==" },
        });
        return sse([
          { type: "message_start", message: { usage: { input_tokens: 4 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "considering" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque-signature" },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"x":1}' },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 2 },
          },
        ]);
      }
      const content = body.messages[1]?.content as Array<Record<string, unknown>>;
      expect(content).toEqual([
        { type: "thinking", thinking: "considering", signature: "opaque-signature" },
        { type: "tool_use", id: "c1", name: "echo", input: { x: 1 } },
      ]);
      const results = body.messages[2]?.content as Array<Record<string, unknown>>;
      expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 6 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "claude-sonnet-5",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    const firstRequest: Parameters<ModelProvider["stream"]>[0] = {
      ...request("claude-sonnet-5"),
      messages: [
        {
          role: "user",
          text: "look",
          attachments: [{ kind: "image", mimeType: "image/png", data: "QQ==", bytes: 1 }],
        },
      ],
    };
    const attachmentEvents: ProviderEvent[] = [];
    for await (const event of provider.stream(firstRequest)) attachmentEvents.push(event);
    const completed = attachmentEvents.at(-1);
    if (!completed || completed.type !== "completed") throw new Error("missing completion");
    const secondRequest = {
      ...request("claude-sonnet-5"),
      messages: [
        ...firstRequest.messages,
        completed.message,
        {
          role: "tool" as const,
          callId: "c1",
          result: { content: [{ type: "text" as const, text: "ok" }] },
        },
      ],
    };
    const second: ProviderEvent[] = [];
    for await (const event of provider.stream(secondRequest)) second.push(event);
    expect(second.at(-1)).toMatchObject({ type: "completed", message: { text: "done" } });
  });
});

describe("OpenCode Console truncation", () => {
  it("chat: length with text completes truncated; length with empty text throws", async () => {
    const withText = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]),
    );
    const events = await collect(
      openCode("deepseek-v4-pro", withText as typeof fetch),
      "deepseek-v4-pro",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });

    const empty = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "" }, finish_reason: "length" }] }]),
    );
    await expect(
      collect(openCode("deepseek-v4-pro", empty as typeof fetch), "deepseek-v4-pro"),
    ).rejects.toThrow(/max output tokens/);
  });

  it("chat: length with a partial tool call throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          choices: [
            {
              delta: {
                content: "trying",
                tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"x":' } }],
              },
              finish_reason: "length",
            },
          ],
        },
      ]),
    );
    await expect(
      collect(openCode("deepseek-v4-pro", fetchMock as typeof fetch), "deepseek-v4-pro"),
    ).rejects.toThrow(/Incomplete tool call/);
  });

  it("responses: response.incomplete with text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
          },
        },
      ]),
    );
    const events = await collect(openCode("gpt-6-sol", fetchMock as typeof fetch), "gpt-6-sol");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("messages: stop_reason max_tokens with text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    const events = await collect(
      openCode("claude-sonnet-5", fetchMock as typeof fetch),
      "claude-sonnet-5",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("messages: max_tokens with a cut tool-call argument throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"x":' },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    await expect(
      collect(openCode("claude-sonnet-5", fetchMock as typeof fetch), "claude-sonnet-5"),
    ).rejects.toThrow(/cut off/);
  });

  it("messages: max_tokens with no text and no calls throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    await expect(
      collect(openCode("claude-sonnet-5", fetchMock as typeof fetch), "claude-sonnet-5"),
    ).rejects.toThrow(/max output tokens/);
  });
});
