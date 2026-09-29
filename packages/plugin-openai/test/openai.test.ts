import { inspect } from "node:util";
import type { ModelProvider, Plugin, ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIPlugin, OpenAIProvider } from "../src/index.js";

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
  const items: ProviderEvent[] = [];
  for await (const e of p.stream({
    instructions: "test",
    messages: [{ role: "user", text: "hello" }],
    tools: [],
    maxOutputTokens: 12,
    signal: AbortSignal.timeout(1000),
    model: "gpt-test",
  }))
    items.push(e);
  return items;
};
describe("OpenAI plugin", () => {
  it("registers an API-key-only provider and stored credentials remain private", () => {
    const value = registration(createOpenAIPlugin());
    expect(value.id).toBe("openai");
    expect(value.fields).toEqual([expect.objectContaining({ key: "apiKey", kind: "secret" })]);
    const p = value.create({ profile: {}, credentials: { apiKey: "private-key" } } as never);
    expect(JSON.stringify(p)).not.toContain("private-key");
    expect(inspect(p, { showHidden: true })).not.toContain("private-key");
  });
  it("uses the environment only when no stored key exists", () => {
    vi.stubEnv("OPENAI_API_KEY", "env-key");
    expect(() =>
      registration(createOpenAIPlugin()).create({ profile: {}, credentials: {} } as never),
    ).not.toThrow();
  });
  it("streams text, usage, tools and opaque continuation data", async () => {
    const provider = new OpenAIProvider(
      { apiKey: "fake", model: "gpt-test" },
      client({
        responses: {
          async create() {
            return (async function* () {
              yield { type: "response.output_text.delta", delta: "hello" };
              yield { type: "response.reasoning_summary_text.delta", delta: "summary" };
              yield {
                type: "response.completed",
                response: {
                  output: [{ type: "function_call", call_id: "c1", name: "echo", arguments: "{}" }],
                  usage: { input_tokens: 2, output_tokens: 3 },
                },
              };
            })();
          },
        },
      }),
    );
    expect(await collect(provider)).toEqual([
      { type: "text_delta", delta: "hello" },
      { type: "reasoning_delta", delta: "summary" },
      expect.objectContaining({
        type: "completed",
        usage: { input: 2, output: 3 },
        message: expect.objectContaining({ calls: [{ id: "c1", name: "echo", arguments: "{}" }] }),
      }),
    ]);
  });
  it("rejects malformed and failed streams", async () => {
    const provider = new OpenAIProvider(
      { apiKey: "fake", model: "x" },
      client({
        responses: {
          async create() {
            return (async function* () {
              yield { type: "response.failed" };
            })();
          },
        },
      }),
    );
    await expect(collect(provider)).rejects.toThrow(/failed/);
  });
});
