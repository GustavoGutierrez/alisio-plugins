import type { Plugin, ToolDefinition } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createLiteratureResearchPlugin,
  createTools,
  identifier,
  readInput,
  searchInput,
} from "../src/index.js";

const context = { signal: AbortSignal.timeout(1000), workspace: ".", emit() {} };
const tool = (name: string, fetcher: typeof fetch) =>
  createTools(fetcher).find((x) => x.name === name) as ToolDefinition;
describe("literature research", () => {
  it("registers bounded external tools", () => {
    const registered: ToolDefinition[] = [];
    createLiteratureResearchPlugin().setup({
      tools: {
        register(t: ToolDefinition) {
          registered.push(t);
          return () => {};
        },
      },
    } as unknown as Parameters<Plugin["setup"]>[0]);
    expect(registered.map((x) => [x.name, x.effect])).toEqual([
      ["literature_search", "external"],
      ["paper_discover", "external"],
      ["literature_read", "external"],
    ]);
    expect(registered[0]?.inputSchema).toMatchObject({ additionalProperties: false });
  });
  it("canonicalizes only recognized identifiers and strict input", () => {
    expect(identifier("https://doi.org/10.1000/ABC")).toEqual({
      kind: "doi",
      value: "10.1000/abc",
    });
    expect(identifier("arXiv:2401.12345v2")).toEqual({
      kind: "arxiv",
      value: "2401.12345",
      version: "2",
    });
    expect(identifier("W123")).toEqual({ kind: "openalex", value: "W123" });
    expect(() => identifier("https://example.com/a")).toThrow("invalid input");
    expect(() => readInput({ identifier: "W1", host: "evil" })).toThrow();
    expect(() => searchInput({ query: "x", limit: 11 })).toThrow();
  });
  it("maps OpenAlex search and escapes source text", async () => {
    const f = vi.fn(async () =>
      Response.json({
        results: [
          {
            id: "https://openalex.org/W1",
            title: "A *title*",
            authorships: [{ author: { display_name: "A" } }],
            publication_date: "2025-01-01",
            abstract_inverted_index: { hello: [0], world: [1] },
          },
        ],
      }),
    );
    const r = await tool("literature_search", f as typeof fetch).execute(
      { query: "topic", limit: 1 },
      context,
    );
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("A \\*title\\*") });
    expect(f.mock.calls[0]?.[0]).toContain("https://api.openalex.org/works?");
  });
  it("reads Crossref DOI and arXiv identifiers from fixed origins", async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith("https://api.crossref.org")
        ? Response.json({
            message: { DOI: "10.1000/a", title: ["Paper"], author: [{ given: "A", family: "B" }] },
          })
        : new Response(
            `<feed><entry><id>http://arxiv.org/abs/2401.12345</id><title>Atom paper</title><summary>Abstract</summary><author><name>A</name></author><published>2024-01-01T00:00:00Z</published></entry></feed>`,
          ),
    );
    const a = await tool("literature_read", f as typeof fetch).execute(
      { identifier: "doi:10.1000/a" },
      context,
    );
    const b = await tool("literature_read", f as typeof fetch).execute(
      { identifier: "2401.12345" },
      context,
    );
    expect(a.content[0]).toMatchObject({ text: expect.stringContaining("crossref") });
    expect(b.content[0]).toMatchObject({ text: expect.stringContaining("Atom paper") });
    expect(f.mock.calls.map((x) => x[0]).join(" ")).not.toContain("example.com");
  });
  it("returns stable failures for redirects, invalid JSON and oversize", async () => {
    for (const response of [
      new Response("", { status: 302, headers: { location: "https://evil.test" } }),
      new Response("nope"),
      new Response("x".repeat(512 * 1024 + 1)),
    ]) {
      const f = vi.fn(async () => response);
      const r = await tool("literature_search", f as typeof fetch).execute({ query: "x" }, context);
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).not.toContain("evil");
    }
  });
});
