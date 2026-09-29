import { inspect } from "node:util";
import type {
  CommandOptions,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import plugin, {
  authorizationHeader,
  buildPath,
  COMMAND_NAMES,
  createAtlassianPlugin,
  createClient,
  DEFAULT_ISSUE_FIELDS,
  extractPageId,
  frameUntrusted,
  isWritesEnabled,
  loadConfig,
  MAX_OUTPUT_CHARS,
  MAX_RESPONSE_BYTES,
  ROUTES,
  resourcePaths,
  sanitizeRemoteText,
  TOOL_NAMES,
  TRUNCATION_MARKER,
  UNTRUSTED_NOTICE,
} from "../src/index.js";

const TOKEN = "s3cr3t-token-value-do-not-leak";

const baseEnv = {
  ATLASSIAN_BASE_URL: "https://team.atlassian.net",
  ATLASSIAN_EMAIL: "user@example.com",
  ATLASSIAN_API_TOKEN: TOKEN,
};

const context = (signal: AbortSignal = AbortSignal.timeout(1_000)): ToolContext => ({
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

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

function body(call: Call): Record<string, unknown> {
  const raw = call.init.body;
  if (typeof raw !== "string") throw new Error("missing request body");
  return JSON.parse(raw) as Record<string, unknown>;
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

function captureApi(): {
  api: PluginAPI;
  tools: ToolDefinition[];
  commands: Array<{
    name: string;
    handler: (args: string, ctx?: { sessionId?: string }) => Promise<string>;
    options?: CommandOptions;
  }>;
  skills: string[];
} {
  const tools: ToolDefinition[] = [];
  const commands: Array<{
    name: string;
    handler: (args: string, ctx?: { sessionId?: string }) => Promise<string>;
    options?: CommandOptions;
  }> = [];
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

const WRITE_TOOLS = new Set([
  "jira_create_issue",
  "jira_update_issue",
  "jira_add_comment",
  "jira_transition_issue",
  "jira_add_worklog",
  "jira_link_issues",
  "confluence_create_page",
  "confluence_update_page",
  "confluence_add_comment",
  "agile_move_issues",
]);

// ---------------------------------------------------------------------------
// Registration, names, effects, schemas
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers every declared tool, the skill, and the five commands", () => {
    const { api, tools, commands, skills } = captureApi();
    const { fetcher } = createFetcher(() => json({}));
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    expect(tools.map((value) => value.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(TOOL_NAMES.length);
    expect(skills).toEqual([resourcePaths.skills]);
    expect(commands.map((value) => value.name)).toEqual([...COMMAND_NAMES]);
  });

  it("assigns read tools the external effect and write tools the write effect", () => {
    const { api, tools } = captureApi();
    const { fetcher } = createFetcher(() => json({}));
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    for (const value of tools) {
      expect(value.effect).toBe(WRITE_TOOLS.has(value.name) ? "write" : "external");
    }
  });

  it("uses closed object schemas with declared required fields", () => {
    const { api, tools } = captureApi();
    const { fetcher } = createFetcher(() => json({}));
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    for (const value of tools) {
      const schema = value.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, unknown>;
      for (const required of (schema.required as string[] | undefined) ?? []) {
        expect(Object.keys(properties)).toContain(required);
      }
    }
  });

  it("defines the plugin identity and categories", () => {
    expect(plugin.id).toBe("atlassian");
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.categories).toEqual(["tools"]);
  });

  it("fails closed when configuration is missing", () => {
    const { api } = captureApi();
    expect(() => createAtlassianPlugin({ env: {} }).setup(api)).toThrowError(
      /configuration missing or invalid/,
    );
  });

  it("documents the host-namespaced command form", async () => {
    const { api, commands } = captureApi();
    const { fetcher } = createFetcher(() => json({}));
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const issue = commands.find((value) => value.name === "jira-issue");
    expect(issue).toBeDefined();
    expect(await issue?.handler("not-a-key")).toContain("/atlassian:jira-issue");
    expect(COMMAND_NAMES.map((name) => `atlassian:${name}`)).toContain("atlassian:jira-issue");
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("parses a base URL and normalizes a trailing slash", () => {
    const config = loadConfig({ ...baseEnv, ATLASSIAN_BASE_URL: "https://team.atlassian.net/" });
    expect(config.baseUrl).toBe("https://team.atlassian.net");
    expect(config.host).toBe("team.atlassian.net");
  });

  it("derives the base URL from a domain", () => {
    const config = loadConfig({
      ATLASSIAN_DOMAIN: "Team.Atlassian.NET",
      ATLASSIAN_EMAIL: "user@example.com",
      ATLASSIAN_API_TOKEN: TOKEN,
    });
    expect(config.baseUrl).toBe("https://team.atlassian.net");
    expect(config.host).toBe("team.atlassian.net");
  });

  it("rejects both or neither of base URL and domain", () => {
    expect(() => loadConfig({ ...baseEnv, ATLASSIAN_DOMAIN: "team.atlassian.net" })).toThrowError(
      /exactly one/,
    );
    expect(() =>
      loadConfig({ ATLASSIAN_EMAIL: "u@e.com", ATLASSIAN_API_TOKEN: TOKEN }),
    ).toThrowError(/ATLASSIAN_BASE_URL or ATLASSIAN_DOMAIN/);
  });

  it("rejects missing or partial credentials", () => {
    expect(() => loadConfig({ ATLASSIAN_BASE_URL: baseEnv.ATLASSIAN_BASE_URL })).toThrowError(
      /ATLASSIAN_EMAIL/,
    );
    expect(() =>
      loadConfig({
        ATLASSIAN_BASE_URL: baseEnv.ATLASSIAN_BASE_URL,
        ATLASSIAN_EMAIL: baseEnv.ATLASSIAN_EMAIL,
      }),
    ).toThrowError(/ATLASSIAN_API_TOKEN/);
  });

  it.each([
    ["http downgrade", "http://team.atlassian.net"],
    ["localhost", "https://localhost"],
    ["ip literal", "https://127.0.0.1"],
    ["embedded credentials", "https://user:pass@team.atlassian.net"],
    ["non-atlassian host", "https://jira.example.com"],
    ["bare atlassian.net", "https://atlassian.net"],
    ["path", "https://team.atlassian.net/jira"],
    ["query", "https://team.atlassian.net/?x=1"],
    ["fragment", "https://team.atlassian.net/#x"],
    ["double trailing slash", "https://team.atlassian.net//"],
    ["port", "https://team.atlassian.net:8443"],
  ])("rejects %s", (_label, value) => {
    expect(() => loadConfig({ ...baseEnv, ATLASSIAN_BASE_URL: value })).toThrowError(
      /configuration missing or invalid/,
    );
  });

  it("rejects an invalid domain shape", () => {
    expect(() =>
      loadConfig({
        ATLASSIAN_DOMAIN: "team.atlassian.net/evil",
        ATLASSIAN_EMAIL: "user@example.com",
        ATLASSIAN_API_TOKEN: TOKEN,
      }),
    ).toThrowError(/ATLASSIAN_DOMAIN/);
  });

  it("enables writes only for the exact flag", () => {
    expect(isWritesEnabled("1")).toBe(true);
    for (const value of ["true", "yes", "on", "0", "", " 1 0 ", undefined]) {
      expect(isWritesEnabled(value)).toBe(false);
    }
    expect(loadConfig({ ...baseEnv }).allowWrites).toBe(false);
    expect(loadConfig({ ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }).allowWrites).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credentials", () => {
  it("builds a Basic authorization header from email and token", () => {
    const config = loadConfig(baseEnv);
    const expected = Buffer.from(`${baseEnv.ATLASSIAN_EMAIL}:${TOKEN}`, "utf8").toString("base64");
    expect(authorizationHeader(config)).toBe(`Basic ${expected}`);
  });

  it("sends the Basic header and never serializes the token", () => {
    const { fetcher, calls } = createFetcher(() =>
      json({ key: "ABC-1", fields: { summary: "S" } }),
    );
    const config = loadConfig(baseEnv);
    expect(JSON.stringify({ config })).not.toContain(TOKEN);
    expect(inspect(config, { depth: 6 })).not.toContain(TOKEN);
    const client = createClient(config, fetcher);
    void client;
    const tools = createAtlassianPlugin({ env: baseEnv, fetcher });
    const { api, tools: registered } = captureApi();
    tools.setup(api);
    return run(registered, "jira_get_issue", { issueKey: "ABC-1" }).then((result) => {
      expect(header(calls[0] as Call, "authorization")).toBe(authorizationHeader(config));
      expect(textOf(result)).not.toContain(TOKEN);
    });
  });

  it("never returns the token in an error result", async () => {
    const { fetcher } = createFetcher(() => json({ error: "nope" }, 401));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const result = await run(tools, "jira_get_issue", { issueKey: "ABC-1" });
    expect(textOf(result)).toBe("not authenticated");
    expect(textOf(result)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Write safety
// ---------------------------------------------------------------------------

describe("write safety", () => {
  it("refuses every mutating tool without a network call by default", async () => {
    const { fetcher, calls } = createFetcher(() => {
      throw new Error("network must not be reached");
    });
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const inputs: Record<string, Record<string, unknown>> = {
      jira_create_issue: { projectKey: "ABC", issueType: "Task", summary: "s" },
      jira_update_issue: { issueKey: "ABC-1", summary: "s" },
      jira_add_comment: { issueKey: "ABC-1", body: "b" },
      jira_transition_issue: { issueKey: "ABC-1", transitionId: "1" },
      jira_add_worklog: { issueKey: "ABC-1", timeSpentSeconds: 60 },
      jira_link_issues: { type: "Blocks", inwardIssueKey: "ABC-1", outwardIssueKey: "ABC-2" },
      confluence_create_page: { spaceId: "1", title: "t", body: "b" },
      confluence_update_page: { pageId: "1", title: "t", body: "b", versionNumber: 2 },
      confluence_add_comment: { pageId: "1", body: "b" },
      agile_move_issues: { destination: "backlog", issueKeys: ["ABC-1"] },
    };
    for (const name of WRITE_TOOLS) {
      const result = await run(tools, name, inputs[name] ?? {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^writes disabled/);
    }
    expect(calls).toHaveLength(0);
  });

  it("allows a write only when the flag is set", async () => {
    const { fetcher, calls } = createFetcher(() => json({ key: "ABC-9" }, 201));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: { ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }, fetcher }).setup(api);
    const result = await run(tools, "jira_create_issue", {
      projectKey: "ABC",
      issueType: "Task",
      summary: "hello",
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("ABC-9");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

describe("jira", () => {
  it("uses the cursor endpoint with an explicit field list and paging token", async () => {
    const { fetcher, calls } = createFetcher(() =>
      json({
        issues: [{ key: "ABC-1", fields: { summary: "S", status: { name: "Open" } } }],
        nextPageToken: "tok-2",
        isLast: false,
      }),
    );
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const result = await run(tools, "jira_search", {
      jql: "project = ABC",
      fields: ["summary", "status"],
      maxResults: 10,
      nextPageToken: "tok-1",
    });
    expect(calls[0]?.url).toBe("https://team.atlassian.net/rest/api/3/search/jql");
    expect(body(calls[0] as Call)).toEqual({
      jql: "project = ABC",
      fields: ["summary", "status"],
      maxResults: 10,
      nextPageToken: "tok-1",
    });
    expect(textOf(result)).toContain("tok-2");
    expect(textOf(result)).not.toContain("total");
  });

  it("always sends fields, defaulting to the explicit field list", async () => {
    const { fetcher, calls } = createFetcher(() => json({ issues: [] }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    await run(tools, "jira_search", { jql: "project = ABC" });
    expect(body(calls[0] as Call).fields).toEqual([...DEFAULT_ISSUE_FIELDS]);
  });

  it("never targets the removed legacy search path", async () => {
    expect(ROUTES).toContain("/rest/api/3/search/jql");
    expect(ROUTES).not.toContain("/rest/api/3/search");
    expect(() => buildPath("/rest/api/3/search" as never)).toThrowError(/invalid input/);
    const { fetcher, calls } = createFetcher(() => json({ issues: [] }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    await run(tools, "jira_search", { jql: "project = ABC" });
    for (const call of calls) {
      const pathname = new URL(call.url).pathname;
      expect(pathname).not.toBe("/rest/api/3/search");
      expect(pathname).not.toMatch(/\/rest\/api\/3\/search$/);
    }
  });

  it("rejects an unknown field and a malformed issue key without a request", async () => {
    const { fetcher, calls } = createFetcher(() => json({}));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    expect(textOf(await run(tools, "jira_get_issue", { issueKey: "ABC-1", extra: 1 }))).toMatch(
      /^invalid input/,
    );
    expect(textOf(await run(tools, "jira_get_issue", { issueKey: "not a key" }))).toMatch(
      /^invalid input/,
    );
    expect(calls).toHaveLength(0);
  });

  it("bounds the returned result count", async () => {
    const issues = Array.from({ length: 30 }, (_, index) => ({
      key: `ABC-${index + 1}`,
      fields: { summary: `s${index}` },
    }));
    const { fetcher } = createFetcher(() => json({ issues, isLast: true }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const result = await run(tools, "jira_search", { jql: "project = ABC" });
    expect(textOf(result)).toContain("5 more not shown");
    expect((textOf(result).match(/^- ABC-/gm) ?? []).length).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

describe("confluence", () => {
  it("requires version.number for an update and maps 409 to a version conflict", async () => {
    const { fetcher, calls } = createFetcher(() => empty(409));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: { ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }, fetcher }).setup(api);

    const missing = await run(tools, "confluence_update_page", {
      pageId: "1",
      title: "T",
      body: "B",
    });
    expect(textOf(missing)).toMatch(/^invalid input/);
    expect(calls).toHaveLength(0);

    const conflict = await run(tools, "confluence_update_page", {
      pageId: "1",
      title: "T",
      body: "B",
      versionNumber: 2,
    });
    expect(textOf(conflict)).toMatch(/^version conflict/);
    expect(body(calls[0] as Call)).toMatchObject({
      id: "1",
      status: "current",
      title: "T",
      body: { representation: "storage", value: "B" },
      version: { number: 2 },
    });
  });

  it("extracts only a page id and fetches the configured site, never the given host", async () => {
    expect(extractPageId("https://other.atlassian.net/wiki/spaces/S/pages/123/Title")).toBe("123");
    expect(extractPageId("https://team.atlassian.net/wiki/pages/viewpage.action?pageId=456")).toBe(
      "456",
    );
    expect(() => extractPageId("https://evil.example/wiki/pages/123")).toThrowError(
      /atlassian\.net/,
    );
    expect(() => extractPageId("http://team.atlassian.net/wiki/pages/123")).toThrowError(/https/);

    const { fetcher, calls } = createFetcher(() =>
      json({ id: "123", title: "Remote", body: { storage: { value: "<p>hi</p>" } } }),
    );
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);

    const ok = await run(tools, "confluence_get_page_by_url", {
      url: "https://other.atlassian.net/wiki/spaces/S/pages/123/Title",
    });
    expect(ok.isError).toBeUndefined();
    expect(calls[0]?.url).toBe(
      "https://team.atlassian.net/wiki/api/v2/pages/123?body-format=storage",
    );

    const blocked = await run(tools, "confluence_get_page_by_url", {
      url: "https://evil.example/wiki/pages/999",
    });
    expect(textOf(blocked)).toMatch(/^invalid input/);
    expect(calls).toHaveLength(1);
  });

  it("bounds the cursor page size and local limit", async () => {
    const { fetcher } = createFetcher(() => json({ results: [] }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const tooBig = await run(tools, "confluence_search", { limit: 101 });
    expect(textOf(tooBig)).toMatch(/^invalid input/);
    const ok = await run(tools, "confluence_search", { limit: 100 });
    expect(ok.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agile
// ---------------------------------------------------------------------------

describe("agile", () => {
  it("rejects more than 50 issues in one move without a request", async () => {
    const { fetcher, calls } = createFetcher(() => empty());
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: { ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }, fetcher }).setup(api);
    const keys = Array.from({ length: 51 }, (_, index) => `ABC-${index + 1}`);
    const result = await run(tools, "agile_move_issues", {
      destination: "backlog",
      issueKeys: keys,
    });
    expect(textOf(result)).toMatch(/^invalid input/);
    expect(textOf(result)).toContain("at most 50");
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly 50 and posts to the backlog endpoint", async () => {
    const { fetcher, calls } = createFetcher(() => empty());
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: { ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }, fetcher }).setup(api);
    const keys = Array.from({ length: 50 }, (_, index) => `ABC-${index + 1}`);
    const result = await run(tools, "agile_move_issues", {
      destination: "backlog",
      issueKeys: keys,
    });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.url).toBe("https://team.atlassian.net/rest/agile/1.0/backlog/issue");
    expect((body(calls[0] as Call).issues as string[]).length).toBe(50);
  });

  it("requires the destination-specific identifier", async () => {
    const { fetcher, calls } = createFetcher(() => empty());
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: { ...baseEnv, ATLASSIAN_ALLOW_WRITES: "1" }, fetcher }).setup(api);
    expect(
      textOf(
        await run(tools, "agile_move_issues", { destination: "sprint", issueKeys: ["ABC-1"] }),
      ),
    ).toMatch(/sprintId/);
    expect(
      textOf(await run(tools, "agile_move_issues", { destination: "epic", issueKeys: ["ABC-1"] })),
    ).toMatch(/epicIdOrKey/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP safety
// ---------------------------------------------------------------------------

describe("http safety", () => {
  const setup = (handler: (call: Call) => Response | Promise<Response>) => {
    const recorded = createFetcher(handler);
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher: recorded.fetcher }).setup(api);
    return { ...recorded, tools };
  };

  it("refuses redirects and refuses to follow them", async () => {
    const redirect = {
      status: 200,
      redirected: true,
      url: "",
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const { tools, calls } = setup(() => redirect);
    const result = await run(tools, "jira_get_issue", { issueKey: "ABC-1" });
    expect(textOf(result)).toMatch(/^invalid response/);
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("rejects a response larger than the hard cap", async () => {
    const oversized = new Response("x".repeat(MAX_RESPONSE_BYTES + 128), { status: 200 });
    const { tools } = setup(() => oversized);
    const result = await run(tools, "jira_get_issue", { issueKey: "ABC-1" });
    expect(textOf(result)).toBe("response exceeded limit");
  });

  it("propagates aborts through the combined signal", async () => {
    const controller = new AbortController();
    let combined: AbortSignal | undefined;
    const { fetcher } = createFetcher((call) => {
      combined = call.init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        call.init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const pending = run(tools, "jira_get_issue", { issueKey: "ABC-1" }, controller.signal);
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
      [500, "temporarily unavailable"],
    ];
    for (const [status, expected] of cases) {
      const { tools } = setup(() => empty(status));
      expect(textOf(await run(tools, "jira_get_issue", { issueKey: "ABC-1" }))).toBe(expected);
    }
  });

  it("surfaces a sanitized Retry-After for rate limits and outages", async () => {
    const { fetcher, calls } = createFetcher(() => json({}, 429, { "retry-after": "45" }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const client = createClient(loadConfig(baseEnv), fetcher, { now: () => Date.UTC(2026, 0, 1) });
    void client;
    expect(textOf(await run(tools, "jira_get_issue", { issueKey: "ABC-1" }))).toBe(
      "rate limited: retry after 45 seconds",
    );
    expect(calls).toHaveLength(1);
  });

  it("caps a Retry-After HTTP date using the injected clock", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const retryAt = new Date(now + 60_000).toUTCString();
    const { fetcher } = createFetcher(() => json({}, 503, { "retry-after": retryAt }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher, clock: { now: () => now } }).setup(api);
    expect(textOf(await run(tools, "jira_get_issue", { issueKey: "ABC-1" }))).toBe(
      "temporarily unavailable: retry after 60 seconds",
    );
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

  it("frames content as untrusted and clamps the aggregate", async () => {
    const long = "a".repeat(50_000);
    const { fetcher } = createFetcher(() => json({ key: "ABC-1", fields: { summary: long } }));
    const { api, tools } = captureApi();
    createAtlassianPlugin({ env: baseEnv, fetcher }).setup(api);
    const result = await run(tools, "jira_get_issue", { issueKey: "ABC-1" });
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
    const framed = frameUntrusted("Issue: ABC-1");
    expect(framed.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(framed).toContain("Issue: ABC-1");
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("cli", () => {
  function io(env: Record<string, string | undefined>) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      options: {
        env,
        write: (text: string) => out.push(text),
        writeError: (text: string) => err.push(text),
      },
    };
  }

  it("prints usage for --help without configuration", async () => {
    const sink = io({});
    const { runCli } = await import("../src/cli.js");
    const code = await runCli(["--help"], sink.options);
    expect(code).toBe(0);
    expect(sink.out.join("\n")).toContain("Usage: alisio-atlassian");
    expect(sink.err).toHaveLength(0);
  });

  it("reads an issue and prints framed output without the token", async () => {
    const { fetcher, calls } = createFetcher(() =>
      json({ key: "ABC-123", fields: { summary: "Fix the thing", status: { name: "Open" } } }),
    );
    const sink = io(baseEnv);
    const { runCli } = await import("../src/cli.js");
    const code = await runCli(["jira", "ABC-123"], { ...sink.options, fetcher });
    expect(code).toBe(0);
    const output = sink.out.join("\n");
    expect(output).toContain(UNTRUSTED_NOTICE);
    expect(output).toContain("ABC-123");
    expect(output).not.toContain(TOKEN);
    expect(calls[0]?.url).toContain("/rest/api/3/issue/ABC-123");
  });

  it("accepts a Confluence link and only fetches the configured site", async () => {
    const { fetcher, calls } = createFetcher(() =>
      json({ id: "55", title: "Page", body: { storage: { value: "body" } } }),
    );
    const sink = io(baseEnv);
    const { runCli } = await import("../src/cli.js");
    const code = await runCli(["confluence", "https://other.atlassian.net/wiki/pages/55"], {
      ...sink.options,
      fetcher,
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://team.atlassian.net/wiki/api/v2/pages/55?body-format=storage",
    );
  });

  it("exits non-zero on configuration errors", async () => {
    const sink = io({});
    const { runCli } = await import("../src/cli.js");
    const code = await runCli(["jira", "ABC-123"], sink.options);
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("configuration");
  });

  it("exits non-zero on API errors with a safe message", async () => {
    const { fetcher } = createFetcher(() => empty(500));
    const sink = io(baseEnv);
    const { runCli } = await import("../src/cli.js");
    const code = await runCli(["jira", "ABC-123"], { ...sink.options, fetcher });
    expect(code).toBe(1);
    expect(sink.err.join("\n")).toContain("temporarily unavailable");
    expect(sink.err.join("\n")).not.toContain(TOKEN);
  });

  it("rejects an unknown command", async () => {
    const sink = io(baseEnv);
    const { runCli } = await import("../src/cli.js");
    expect(await runCli(["bogus"], sink.options)).toBe(2);
  });
});
