import { inspect } from "node:util";
import type { Plugin, ToolDefinition } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { createTools, createWebSearchPlugin, settings } from "../src/index.js";
import { assertPublicUrl, parsePublicUrl, parseSearchInput } from "../src/validation.js";

const context = { signal: AbortSignal.timeout(1_000), workspace: ".", emit() {} };
const tool = (tools: ToolDefinition[], name: string) =>
  tools.find((value) => value.name === name) as ToolDefinition;

describe("web search plugin", () => {
  it("registers two external tools with bounded schemas", () => {
    const plugin = createWebSearchPlugin();
    const registered: ToolDefinition[] = [];
    plugin.setup({
      tools: {
        register(value: ToolDefinition) {
          registered.push(value);
          return () => {};
        },
      },
    } as unknown as Parameters<Plugin["setup"]>[0]);
    expect(registered.map((value) => [value.name, value.effect])).toEqual([
      ["web_search", "external"],
      ["web_fetch", "external"],
    ]);
    expect(tool(registered, "web_search").inputSchema).toMatchObject({
      additionalProperties: false,
    });
  });
  it("validates inputs and rejects unsafe URLs", async () => {
    expect(parseSearchInput({ query: " q ", maxResults: 5 }).query).toBe("q");
    expect(() => parseSearchInput({ query: "", maxResults: 21 })).toThrow();
    expect(() => parsePublicUrl("http://127.0.0.1/a")).toThrow();
    await expect(assertPublicUrl("https://localhost/a")).rejects.toThrow();
  });
  it("maps SearXNG results and removes invalid result URLs", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { title: "Good", url: "https://example.com/a", content: "snippet" },
          { title: "Bad", url: "http://127.0.0.1/" },
        ],
      }),
    );
    const config = settings(
      { providerRoute: "searxng", searxngUrl: "https://search.example.com" },
      {},
    );
    const result = await tool(createTools(config, fetcher as typeof fetch), "web_search").execute(
      { query: "test" },
      context,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Good") });
    expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("Bad") });
  });
  it("uses the configured route and never falls through a failed active provider", async () => {
    const fetcher = vi.fn(async () => new Response("down", { status: 503 }));
    const config = settings(
      { providerRoute: "searxng,exaMcp", searxngUrl: "https://search.example.com" },
      {},
    );
    const result = await tool(createTools(config, fetcher as typeof fetch), "web_search").execute(
      { query: "test" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires explicit fetch opt-in and keeps keys out of inspection", async () => {
    const config = settings(
      { providerRoute: "tavily", enableFetch: false },
      { tavilyApiKey: "secret-key" },
    );
    const result = await tool(createTools(config), "web_fetch").execute(
      { url: "https://example.com" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(config)).not.toContain("secret-key");
    expect(inspect(createTools(config))).not.toContain("secret-key");
  });
});
