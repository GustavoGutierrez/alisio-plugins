import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import type { PluginAPI, ToolContext, ToolDefinition, ToolResult } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import plugin, {
  apiKeyFromEnvironment,
  CLIENT_NAME,
  createContext7Plugin,
  createTools,
  escapeMarkdown,
  extractLibraryId,
  type Fetcher,
  MAX_BODY_BYTES,
  MAX_OUTPUT_CHARS,
  MCP_ENDPOINT,
  PROTOCOL_VERSION,
  PROVENANCE,
  parseCommandArguments,
  parseLibraryId,
  parseQueryDocsInput,
  parseResolveInput,
  QUERY_TOOL,
  RESOLVE_TOOL,
  resourcePaths,
  runDocsCommand,
} from "../src/index.js";

const context = (signal: AbortSignal = AbortSignal.timeout(1_000)): ToolContext => ({
  signal,
  workspace: ".",
  emit() {},
});

const textOf = (result: ToolResult): string => {
  for (const part of result.content) if (part.type === "text") return part.text;
  return "";
};

const tool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const found = tools.find((value) => value.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const runTool = (
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> => tool(tools, name).execute(input, context(signal));

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
};

type Behaviour = {
  sessionId?: string | undefined;
  json?: boolean;
  tools?: string[];
  result?: unknown;
  resultFor?: (name: string) => unknown;
  fail?: (call: Call, index: number) => Response | undefined;
};

const sse = (messages: unknown[]): string =>
  messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return { ...((headers as Record<string, string> | undefined) ?? {}) };
}

function createServer(behaviour: Behaviour = {}) {
  const calls: Call[] = [];
  const json = behaviour.json ?? true;
  const sessionHeaders = behaviour.sessionId ? { "mcp-session-id": behaviour.sessionId } : {};
  const respond = (id: unknown, result: unknown): Response =>
    json
      ? new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
          status: 200,
          headers: { "content-type": "application/json", ...sessionHeaders },
        })
      : new Response(sse([{ jsonrpc: "2.0", id, result }]), {
          status: 200,
          headers: { "content-type": "text/event-stream", ...sessionHeaders },
        });

  const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const call: Call = {
      url: String(input),
      method,
      headers: normalizeHeaders(init.headers),
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const override = behaviour.fail?.(call, calls.length - 1);
    if (override) return override;
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (body?.method === "initialize")
      return respond(1, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: "context7", version: "1" },
      });
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body?.method === "tools/list") {
      const names = behaviour.tools ?? [RESOLVE_TOOL, QUERY_TOOL];
      return respond(2, {
        tools: names.map((name) => ({ name, description: "EVIL", inputSchema: { evil: true } })),
      });
    }
    if (body?.method === "tools/call") {
      const name = String((body.params as Record<string, unknown> | undefined)?.name ?? "");
      const result = behaviour.resultFor
        ? behaviour.resultFor(name)
        : (behaviour.result ?? { content: [{ type: "text", text: "docs body" }] });
      return respond(3, result);
    }
    return new Response(null, { status: 400 });
  });
  return { fetcher: fetcher as unknown as Fetcher, calls };
}

const overrideFor = (method: string, response: () => Response): Behaviour["fail"] => {
  return (call) => (call.body?.method === method ? response() : undefined);
};

describe("plugin registration", () => {
  it("registers two external tools, one skill directory, and the c7-docs command", async () => {
    const tools: ToolDefinition[] = [];
    const skills: string[] = [];
    const commands = new Map<string, { handler: unknown; options: unknown }>();
    const api = {
      tools: {
        register(value: ToolDefinition) {
          tools.push(value);
          return () => {};
        },
      },
      resources: {
        skills(path: string) {
          skills.push(path);
        },
      },
      commands: {
        register(name: string, handler: unknown, options: unknown) {
          commands.set(name, { handler, options });
          return () => {};
        },
      },
    } as unknown as PluginAPI;

    const created = createContext7Plugin();
    await created.setup(api);

    expect(created.id).toBe("context7");
    expect(tools.map((value) => [value.name, value.effect])).toEqual([
      [RESOLVE_TOOL, "external"],
      [QUERY_TOOL, "external"],
    ]);
    for (const value of tools) {
      expect(value.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ["libraryName", "query"],
      properties: { libraryName: { maxLength: 120 }, query: { maxLength: 500 } },
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      required: ["libraryId", "query"],
      properties: { libraryId: { maxLength: 256 } },
    });
    expect(skills).toEqual([resourcePaths.skills]);
    expect([...commands.keys()]).toEqual(["c7-docs"]);
    expect(commands.get("c7-docs")?.options).toMatchObject({
      description: expect.any(String),
      argumentHint: "<library> -- <question>",
    });
    // The host namespaces external plugin commands as `<plugin id>:<name>`.
    expect(`${created.id}:c7-docs`).toBe("context7:c7-docs");
  });

  it("ships the skill contract as a valid package resource", async () => {
    expect(plugin.id).toBe("context7");
    const path = resolve(import.meta.dirname, "..", ".agents/skills/context7-docs/SKILL.md");
    const source = await readFile(path, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
    const description = /^description:\s*"?(.*?)"?$/m.exec(frontmatter)?.[1] ?? "";
    expect(/^name:\s*context7-docs$/m.test(frontmatter)).toBe(true);
    expect(description.startsWith("Trigger:")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(250);
    expect(source).toContain("resolve-library-id");
    expect(source).toContain("query-docs");
    expect(source).toContain("secrets");
    // The registered resource directory resolves from `dist/index.js` to the package root.
    expect(join(resolve(import.meta.dirname, "..", "dist"), resourcePaths.skills)).toBe(
      resolve(import.meta.dirname, "..", ".agents/skills"),
    );
  });
});

describe("input validation", () => {
  it("accepts and trims valid inputs", () => {
    expect(parseResolveInput({ libraryName: "  react ", query: " hooks " })).toEqual({
      libraryName: "react",
      query: "hooks",
    });
    expect(
      parseQueryDocsInput({ libraryId: " /vercel/next.js/v15.1.8 ", query: "routing" }),
    ).toEqual({ libraryId: "/vercel/next.js/v15.1.8", query: "routing" });
  });

  it("rejects unknown fields, wrong types, and out-of-range lengths", () => {
    expect(() => parseResolveInput({ libraryName: "a", query: "b", extra: true })).toThrow(
      "invalid input",
    );
    expect(() => parseResolveInput({ libraryName: "", query: "b" })).toThrow("invalid input");
    expect(() => parseResolveInput({ libraryName: "a", query: "" })).toThrow("invalid input");
    expect(() => parseResolveInput({ libraryName: "a".repeat(121), query: "b" })).toThrow(
      "invalid input",
    );
    expect(() => parseResolveInput({ libraryName: "a", query: "b".repeat(501) })).toThrow(
      "invalid input",
    );
    expect(() => parseResolveInput({ libraryName: 7, query: "b" })).toThrow("invalid input");
    expect(() => parseQueryDocsInput({ libraryId: "/a/b", query: "q", extra: 1 })).toThrow(
      "invalid input",
    );
  });

  it("enforces the documented library id grammar", () => {
    for (const valid of [
      "/vercel/next.js",
      "/websites/uploadcare",
      "/vercel/next.js/v15.1.8",
      "/npm/@scope/pkg",
    ])
      expect(parseLibraryId(valid)).toBe(valid);
    for (const bad of [
      "vercel/next.js",
      "/vercel",
      "/a/b/c/d",
      "/vercel//next",
      "/vercel/..",
      "/vercel/next/",
      "/vercel/next?x=1",
      `/${"a".repeat(300)}/b`,
      "",
      "   ",
      {},
    ])
      expect(() => parseLibraryId(bad)).toThrow("invalid input");
  });

  it("reads the key only from the fixed environment variable", () => {
    expect(apiKeyFromEnvironment({})).toBeUndefined();
    expect(apiKeyFromEnvironment({ CONTEXT7_API_KEY: "   " })).toBeUndefined();
    expect(apiKeyFromEnvironment({ CONTEXT7_API_KEY: "short" })).toBeUndefined();
    expect(apiKeyFromEnvironment({ CONTEXT7_API_KEY: "bad key value" })).toBeUndefined();
    expect(apiKeyFromEnvironment({ OTHER_KEY: "key-123456" })).toBeUndefined();
    expect(apiKeyFromEnvironment({ CONTEXT7_API_KEY: " key-123456 " })).toBe("key-123456");
  });
});

describe("transport framing", () => {
  it("runs initialize -> initialized -> tools/list -> tools/call with matching ids", async () => {
    const server = createServer({ sessionId: "sess-framing" });
    await runTool(createTools(server.fetcher), QUERY_TOOL, {
      libraryId: "/vercel/next.js",
      query: "routing",
    });

    expect(server.calls.map((call) => [call.method, call.body?.method ?? null])).toEqual([
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["POST", "tools/list"],
      ["POST", "tools/call"],
      ["DELETE", null],
    ]);
    for (const call of server.calls) expect(call.url).toBe(MCP_ENDPOINT);
    expect(server.calls[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    expect(server.calls[1]?.body).not.toHaveProperty("id");
    expect(server.calls[2]?.body).toMatchObject({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(server.calls[3]?.body).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: QUERY_TOOL, arguments: { libraryId: "/vercel/next.js", query: "routing" } },
    });
    for (const call of server.calls.filter((value) => value.method === "POST")) {
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.headers.accept).toBe("application/json, text/event-stream");
    }
  });

  it("parses JSON responses", async () => {
    const server = createServer({ json: true });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("docs body");
    expect(textOf(result).startsWith(PROVENANCE)).toBe(true);
  });

  it("parses SSE responses", async () => {
    const server = createServer({ json: false });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(textOf(result)).toContain("docs body");
  });

  it("ignores remote descriptions, schemas, and extra tools", async () => {
    const server = createServer({
      tools: [RESOLVE_TOOL, QUERY_TOOL, "some-other-tool"],
      result: { content: [{ type: "text", text: "kept" }] },
    });
    const result = await runTool(createTools(server.fetcher), QUERY_TOOL, {
      libraryId: "/a/b",
      query: "q",
    });
    expect(textOf(result)).toContain("kept");
    expect(textOf(result)).not.toContain("EVIL");
  });

  it("fails when the allowlisted tool is missing and never invokes it", async () => {
    const server = createServer({ tools: [RESOLVE_TOOL] });
    const result = await runTool(createTools(server.fetcher), QUERY_TOOL, {
      libraryId: "/a/b",
      query: "q",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("invalid response");
    expect(server.calls.filter((call) => call.body?.method === "tools/call")).toHaveLength(0);
  });

  it("verifies the client identity uses the independent name", () => {
    expect(CLIENT_NAME).not.toContain("context7-mcp");
    expect(CLIENT_NAME).toBe("alisio-plugin-context7");
    expect(MCP_ENDPOINT).toBe("https://mcp.context7.com/mcp");
  });
});

describe("sessions and cleanup", () => {
  it("carries the server session id and issues an independent DELETE", async () => {
    const server = createServer({ sessionId: "sess-abc-123" });
    await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    const posts = server.calls.filter((call) => call.method === "POST");
    expect(posts[0]?.headers["mcp-session-id"]).toBeUndefined();
    for (const call of posts.slice(1)) expect(call.headers["mcp-session-id"]).toBe("sess-abc-123");
    const deleted = server.calls.find((call) => call.method === "DELETE");
    expect(deleted?.headers["mcp-session-id"]).toBe("sess-abc-123");
  });

  it("ignores cleanup failures", async () => {
    const server = createServer({
      sessionId: "sess-abc-123",
      fail: (call) =>
        call.method === "DELETE" ? new Response("nope", { status: 500 }) : undefined,
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("docs body");
  });
});

describe("authentication handling", () => {
  it("sends no authorization header anonymously", async () => {
    const server = createServer({});
    await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls) expect(call.headers.authorization).toBeUndefined();
  });

  it("sends exactly one bearer header per request when keyed", async () => {
    const server = createServer({});
    const key = "key-123456";
    await runTool(createTools(server.fetcher, key), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    const posts = server.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(4);
    for (const call of posts) expect(call.headers.authorization).toBe(`Bearer ${key}`);
  });

  it("never exposes the key in serialization, inspection, or results", async () => {
    const key = "key-123456";
    const tools = createTools(createServer({}).fetcher, key);
    expect(JSON.stringify(tools)).not.toContain(key);
    expect(inspect(tools)).not.toContain(key);

    const failing = vi.fn(async () => {
      throw new Error(`leak ${key}`);
    });
    const result = await runTool(createTools(failing as unknown as Fetcher, key), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(inspect(result)).not.toContain(key);
  });
});

describe("protocol rejection", () => {
  const expectRejected = async (server: ReturnType<typeof createServer>): Promise<void> => {
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("invalid response");
  };

  it("rejects malformed JSON", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response("not json{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a wrong-id response", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a batch", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a notification where a response is required", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    await expectRejected(server);
  });

  it("rejects duplicate responses in one SSE stream", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(
            sse([
              { jsonrpc: "2.0", id: 1, result: {} },
              { jsonrpc: "2.0", id: 1, result: {} },
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a protocol error without leaking its payload", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32600, message: "raw-secret-payload" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a wrong jsonrpc version", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await expectRejected(server);
  });

  it("rejects an unsupported content type", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    });
    await expectRejected(server);
  });

  it("rejects a declared body larger than the limit", async () => {
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(MAX_BODY_BYTES + 1),
            },
          }),
      ),
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(textOf(result)).toBe("response exceeded limit");
  });

  it("rejects a streamed body larger than the limit", async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(MAX_BODY_BYTES + 1)}"}`;
    const server = createServer({
      fail: overrideFor(
        "initialize",
        () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(textOf(result)).toBe("response exceeded limit");
  });
});

describe("failure mapping", () => {
  const statusCase = async (
    status: number,
    headers: Record<string, string>,
  ): Promise<ToolResult> => {
    const server = createServer({
      fail: overrideFor("initialize", () => new Response(null, { status, headers })),
    });
    return runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
  };

  it("refuses redirects", async () => {
    const result = await statusCase(302, { location: "https://evil.example" });
    expect(textOf(result)).toBe("redirect refused");
  });

  it("maps rate limiting with and without bounded retry metadata", async () => {
    expect(textOf(await statusCase(429, {}))).toBe("rate limited");
    expect(textOf(await statusCase(429, { "retry-after": "30" }))).toBe(
      "rate limited (retry after 30s)",
    );
    expect(textOf(await statusCase(429, { "retry-after": "soon" }))).toBe("rate limited");
    expect(textOf(await statusCase(429, { "retry-after": "999999" }))).toBe(
      "rate limited (retry after 86400s)",
    );
  });

  it("maps authentication failures, not-found, and server errors", async () => {
    expect(textOf(await statusCase(401, {}))).toBe("authentication failed");
    expect(textOf(await statusCase(403, {}))).toBe("authentication failed");
    expect(textOf(await statusCase(404, {}))).toBe("invalid response");
    expect(textOf(await statusCase(400, {}))).toBe("invalid input");
    expect(textOf(await statusCase(422, {}))).toBe("invalid input");
    expect(textOf(await statusCase(500, {}))).toBe("temporarily unavailable");
    expect(textOf(await statusCase(503, {}))).toBe("temporarily unavailable");
  });

  it("propagates an already-aborted signal without touching the network", async () => {
    const server = createServer({});
    const controller = new AbortController();
    controller.abort();
    const result = await runTool(
      createTools(server.fetcher),
      RESOLVE_TOOL,
      { libraryName: "react", query: "hooks" },
      controller.signal,
    );
    expect(textOf(result)).toBe("temporarily unavailable");
    expect(server.calls).toHaveLength(0);
  });

  it("maps an in-flight abort to the safe vocabulary", async () => {
    const fetcher = vi.fn(
      (_input: unknown, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    const pending = runTool(
      createTools(fetcher as unknown as Fetcher),
      RESOLVE_TOOL,
      { libraryName: "react", query: "hooks" },
      controller.signal,
    );
    controller.abort();
    expect(textOf(await pending)).toBe("temporarily unavailable");
  });
});

describe("untrusted content handling", () => {
  it("bounds output, caps each part, and marks provenance", async () => {
    const server = createServer({
      result: { content: [{ type: "text", text: "x".repeat(30_000) }] },
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    const text = textOf(result);
    expect(text.startsWith(PROVENANCE)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PROVENANCE.length + 2 + MAX_OUTPUT_CHARS);
  });

  it("neutralizes Markdown and control characters", async () => {
    const injected =
      "# Heading\n- item\n[click](https://evil.example)\n<script>alert(1)</script>\u0000tail";
    const server = createServer({ result: { content: [{ type: "text", text: injected }] } });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    const text = textOf(result);
    expect(text).toContain("\\# Heading");
    expect(text).toContain("\\- item");
    expect(text).toContain("\\[click\\]");
    expect(text).toContain("\\<script\\>");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("\u0000");
  });

  it("keeps only text parts and never forwards images or resource URIs", async () => {
    const server = createServer({
      result: {
        content: [
          { type: "image", mimeType: "image/png", data: "AAAA" },
          { type: "resource", resource: { uri: "file:///etc/passwd" } },
          { type: "text", text: "kept" },
        ],
      },
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    const text = textOf(result);
    expect(text).toContain("kept");
    expect(text).not.toContain("image/png");
    expect(text).not.toContain("file:///etc/passwd");
    expect(result.content.every((part) => part.type === "text")).toBe(true);
  });

  it("preserves an upstream error flag as a local classification", async () => {
    const server = createServer({
      result: { isError: true, content: [{ type: "text", text: "not found" }] },
    });
    const result = await runTool(createTools(server.fetcher), RESOLVE_TOOL, {
      libraryName: "react",
      query: "hooks",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(PROVENANCE)).toBe(true);
    expect(textOf(result)).toContain("not found");
  });

  it("escapes Markdown in isolation", () => {
    expect(escapeMarkdown("[a](b)")).toBe("\\[a\\](b)");
    expect(escapeMarkdown("1. item")).toBe("1\\. item");
    expect(escapeMarkdown("> quote")).toBe("\\> quote");
  });
});

describe("c7-docs command", () => {
  it("parses arguments in both supported forms", () => {
    expect(parseCommandArguments("next.js -- routing")).toEqual({
      library: "next.js",
      query: "routing",
    });
    expect(parseCommandArguments("next.js routing here")).toEqual({
      library: "next.js",
      query: "routing here",
    });
    expect(parseCommandArguments("")).toBeUndefined();
    expect(parseCommandArguments("only-one-token")).toBeUndefined();
    expect(parseCommandArguments("-- no library")).toBeUndefined();
  });

  it("resolves and then queries, returning third-party documentation", async () => {
    const server = createServer({
      resultFor: (name) =>
        name === RESOLVE_TOOL
          ? { content: [{ type: "text", text: "Best match: /vercel/next.js" }] }
          : { content: [{ type: "text", text: "Route handlers live in app/**/route.ts" }] },
    });
    const output = await runDocsCommand("next.js -- route handlers?", server.fetcher);
    expect(output).toContain("/vercel/next.js");
    expect(output).toContain("Route handlers live");
    expect(output).toContain(PROVENANCE);
    const calls = server.calls.filter((call) => call.body?.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ params: { name: RESOLVE_TOOL } });
    expect(calls[1]?.body).toMatchObject({
      params: { name: QUERY_TOOL, arguments: { libraryId: "/vercel/next.js" } },
    });
  });

  it("skips resolution when a library id is passed directly", async () => {
    const server = createServer({});
    await runDocsCommand("/vercel/next.js -- routing", server.fetcher);
    const calls = server.calls.filter((call) => call.body?.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ params: { name: QUERY_TOOL } });
  });

  it("returns usage text instead of throwing on bad input", async () => {
    const server = createServer({});
    expect(await runDocsCommand("", server.fetcher)).toContain("/context7:c7-docs");
    expect(await runDocsCommand(`${"x".repeat(600)} -- q`, server.fetcher)).toContain(
      "/context7:c7-docs",
    );
    expect(server.calls).toHaveLength(0);
  });
});

describe("library id extraction", () => {
  it("finds a library id without mistaking a URL path", () => {
    expect(extractLibraryId("see https://example.com/foo/bar then /vercel/next.js")).toBe(
      "/vercel/next.js",
    );
    expect(extractLibraryId("no ids here")).toBeUndefined();
    expect(extractLibraryId("(/websites/uploadcare)")).toBe("/websites/uploadcare");
  });
});
