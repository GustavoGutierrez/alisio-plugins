import { inspect } from "node:util";
import type { ModelProvider, Plugin, ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  classifyOpenCodeGoModel,
  createOpenCodeGoPlugin,
  OpenCodeGoProvider,
} from "../src/index.js";
import { VERSION } from "../src/version.js";

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

const openCodeGo = (model: string, fetchMock: typeof fetch) =>
  new OpenCodeGoProvider({
    apiKey: "fake-opencode-key",
    model,
    baseURL: "http://127.0.0.1/v1",
    fetch: fetchMock,
  });

describe("OpenCode Go plugin registration", () => {
  it("registers separately with a masked API key", () => {
    let found: ProviderRegistration | undefined;
    createOpenCodeGoPlugin().setup({
      providers: {
        register(value: ProviderRegistration) {
          found = value;
          return () => {};
        },
      },
    } as unknown as Parameters<Plugin["setup"]>[0]);
    expect(found?.id).toBe("opencode-go");
    expect(found?.fields).toEqual([expect.objectContaining({ key: "apiKey", kind: "secret" })]);
  });

  it("hides credentials", () => {
    const goKey = "fake-go-inspection-key";
    const provider = new OpenCodeGoProvider({ apiKey: goKey, model: "gpt-5.6-luna" });
    expect(inspect(provider, { showHidden: true, depth: 8 })).not.toContain(goKey);
    expect(JSON.stringify(provider)).not.toContain(goKey);
  });

  it.each([
    ["gpt-5.6-luna", "responses"],
    ["grok-4.7", "responses"],
    ["muse-spark-1.3-contributor", "responses"],
    ["glm-5.3", "chat"],
    ["kimi-k3", "chat"],
    ["longcat-2.0", "chat"],
    ["deepseek-v4-pro", "chat"],
    ["mimo-v2.6-pro", "chat"],
    ["hy4-preview", "chat"],
    ["space-bunny-free", "chat"],
    ["minimax-m3", "messages"],
    ["qwen3.8-max", "messages"],
  ] as const)("classifies %s as %s", (model, protocol) => {
    expect(classifyOpenCodeGoModel(model)).toBe(protocol);
  });
});

describe("OpenCode Go provider", () => {
  it("filters unknown catalog families and fails closed when selected", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "gpt-5.6-luna" }, { id: "omen-alpha" }, { id: "future-unknown" }],
      }),
    );
    const provider = openCodeGo("", fetchMock as typeof fetch);
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      { id: "opencode-go/gpt-5.6-luna" },
    ]);
    await expect(async () => {
      for await (const _ of provider.stream(request("omen-alpha"))) void _;
    }).rejects.toThrow("Unsupported OpenCode Go model family");
  });

  it("serves any model of the provider in one session; the profile model is only the default", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: "deepseek-v4-pro" },
          { id: "muse-spark-1.2-contributor" },
          { id: "minimax-m3" },
        ],
      }),
    ) as unknown as typeof fetch;
    // The chat selector offers every model of the provider, not only the default model's protocol.
    const provider = openCodeGo("deepseek-v4-flash", fetchMock);
    expect((await provider.listModels(AbortSignal.timeout(1000))).map((m) => m.id)).toEqual([
      "opencode-go/deepseek-v4-pro",
      "opencode-go/muse-spark-1.2-contributor",
      "opencode-go/minimax-m3",
    ]);
  });

  it("dispatches a request by the requested model's protocol, not the constructor's default", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      sse([
        {
          type: "response.completed",
          response: {
            output: [{ type: "function_call", call_id: "c1", name: "echo", arguments: "{}" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ]),
    );
    // Constructed with a chat default, yet a responses model is served in the same session.
    const provider = openCodeGo("deepseek-v4-flash", fetchMock as unknown as typeof fetch);
    const result = await collect(provider, "muse-spark-1.2-contributor");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(result.at(-1)).toMatchObject({
      type: "completed",
      message: { calls: [{ id: "c1", name: "echo", arguments: "{}" }] },
    });
  });

  it.each([
    [
      "glm-5.3",
      "/chat/completions",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    ],
    [
      "gpt-5.6-luna",
      "/responses",
      [
        {
          type: "response.completed",
          response: {
            output: [{ type: "function_call", call_id: "c1", name: "echo", arguments: "{}" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ],
    ],
    [
      "minimax-m3",
      "/messages",
      [
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ],
    ],
  ] as const)(
    "routes %s to %s with required headers and tool calls",
    async (model, route, events) => {
      const fakeKey = "fake-opencode-key";
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
        expect(headers.get("user-agent")).toBe(`alisio/${VERSION}`);
        expect(headers.get("x-opencode-session")).toBe("00000000-0000-4000-8000-000000000001");
        return sse([...events]);
      });
      const provider = openCodeGo(model, fetchMock as typeof fetch);
      const result = await collect(provider, model);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(route);
      expect(result.at(-1)).toMatchObject({
        type: "completed",
        message: { calls: [{ id: "c1", name: "echo", arguments: "{}" }] },
      });
      expect(JSON.stringify(result)).not.toContain(fakeKey);
    },
  );
});

describe("OpenCode Go truncation", () => {
  it("chat mirror keeps parity", async () => {
    const fetchMock = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]),
    );
    const events = await collect(openCodeGo("glm-5.3", fetchMock as typeof fetch), "glm-5.3");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("responses: incomplete after text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "response.output_text.delta", delta: "partial " },
        { type: "response.output_text.delta", delta: "answer" },
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: {
            output: [
              { type: "message", content: [{ type: "output_text", text: "partial answer" }] },
            ],
          },
        },
      ]),
    );
    const events = await collect(
      openCodeGo("gpt-5.6-luna", fetchMock as typeof fetch),
      "gpt-5.6-luna",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial answer", truncated: true },
    });
  });

  it("responses: incomplete before any text throws actionably", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: { output: [] },
        },
      ]),
    );
    await expect(
      collect(openCodeGo("gpt-5.6-luna", fetchMock as typeof fetch), "gpt-5.6-luna"),
    ).rejects.toThrow(/max output tokens/);
  });
});
