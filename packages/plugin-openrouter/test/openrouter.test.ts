import { inspect } from "node:util";
import type { ModelProvider, Plugin, ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterPlugin, OpenRouterProvider } from "../src/index.js";

const client = (value: unknown) => value as OpenAI;
const registration = (plugin: Plugin) => {
  let found: ProviderRegistration | undefined;
  plugin.setup({
    providers: {
      register(value: ProviderRegistration) {
        found = value;
        return () => {};
      },
    },
  } as never);
  if (!found) throw new Error("missing registration");
  return found;
};
const collect = async (p: ModelProvider) => {
  const out: ProviderEvent[] = [];
  for await (const e of p.stream({
    instructions: "test",
    messages: [{ role: "user", text: "hello" }],
    tools: [],
    maxOutputTokens: 12,
    signal: AbortSignal.timeout(1000),
    model: "model",
  }))
    out.push(e);
  return out;
};
describe("OpenRouter plugin", () => {
  it("registers secret/env fields, validates names, prefers stored secrets and hides them", () => {
    const r = registration(createOpenRouterPlugin());
    expect(r.id).toBe("openrouter");
    expect(r.fields.find((f) => f.key === "apiKeyEnv")?.defaultValue).toBe("OPENROUTER_API_KEY");
    expect(() =>
      r.create({ profile: { apiKeyEnv: "bad-name" }, credentials: { apiKey: "key" } } as never),
    ).toThrow(/invalid/);
    const p = r.create({ profile: {}, credentials: { apiKey: "private-key" } } as never);
    expect(JSON.stringify(p)).not.toContain("private-key");
    expect(inspect(p, { showHidden: true })).not.toContain("private-key");
    vi.stubEnv("OPENROUTER_API_KEY", "env-key");
    expect(() => r.create({ profile: {}, credentials: {} } as never)).not.toThrow();
  });
  it("caches discovery and retains the free fallback when discovery fails", async () => {
    let calls = 0;
    const p = new OpenRouterProvider(
      { apiKey: "fake", model: "" },
      client({
        models: {
          async *list() {
            calls++;
            yield { id: "vendor/model", name: "Model", context_length: 10 };
          },
        },
      }),
    );
    expect((await p.listModels(AbortSignal.timeout(100))).map((m) => m.id)).toEqual([
      "openrouter/free",
      "vendor/model",
    ]);
    await p.listModels(AbortSignal.timeout(100));
    expect(calls).toBe(1);
    const failed = new OpenRouterProvider(
      { apiKey: "fake", model: "" },
      client({
        models: {
          async *list(signal?: AbortSignal) {
            if (signal?.aborted) yield { id: "unreachable" };
            throw new Error("offline");
          },
        },
      }),
    );
    expect(await failed.listModels(AbortSignal.timeout(100))).toEqual([
      { id: "openrouter/free", name: "OpenRouter Free" },
    ]);
  });
  it("streams text, usage, tools and preserves reasoning details", async () => {
    const p = new OpenRouterProvider(
      { apiKey: "fake", model: "x" },
      client({
        chat: {
          completions: {
            async create() {
              return (async function* () {
                yield {
                  choices: [
                    {
                      delta: {
                        content: "hi",
                        reasoning_details: [{ id: "r" }],
                        tool_calls: [
                          { index: 0, id: "c", function: { name: "echo", arguments: "{}" } },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 2 },
                };
              })();
            },
          },
        },
      }),
    );
    expect(await collect(p)).toEqual([
      { type: "text_delta", delta: "hi" },
      expect.objectContaining({
        type: "completed",
        usage: { input: 1, output: 2 },
        message: expect.objectContaining({
          providerData: [{ id: "r" }],
          calls: [{ id: "c", name: "echo", arguments: "{}" }],
        }),
      }),
    ]);
  });
  it("rejects in-stream error payloads and supports cancellation", async () => {
    const p = new OpenRouterProvider(
      { apiKey: "fake", model: "x" },
      client({
        chat: {
          completions: {
            async create() {
              return (async function* () {
                yield { error: { message: "bad" } };
              })();
            },
          },
        },
      }),
    );
    await expect(collect(p)).rejects.toThrow(/stream error/);
  });
});
