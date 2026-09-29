import { definePlugin, type Plugin, type ToolDefinition, type ToolResult } from "@alisio/sdk";
import { adapters, markdown, type Settings } from "./providers.js";
import {
  assertPublicUrl,
  PROVIDERS,
  type ProviderId,
  parseSearchInput,
  parseSearxngOrigin,
} from "./validation.js";

export const VERSION = "0.1.0";
const stringProfile = (profile: Record<string, string | boolean | number>, key: string) =>
  typeof profile[key] === "string" ? profile[key].trim() : undefined;
const credential = (credentials: Record<string, string>, name: string, env: string) =>
  credentials[name] || process.env[env] || undefined;
const privateCredentials = (credentials: Record<string, string>) => {
  const values: Settings["credentials"] = {};
  for (const [provider, field, env] of [
    ["brave", "braveApiKey", "BRAVE_SEARCH_API_KEY"],
    ["tavily", "tavilyApiKey", "TAVILY_API_KEY"],
    ["jina", "jinaApiKey", "JINA_API_KEY"],
    ["firecrawl", "firecrawlApiKey", "FIRECRAWL_API_KEY"],
    ["exaApi", "exaApiKey", "EXA_API_KEY"],
  ] as const) {
    const value = credential(credentials, field, env);
    if (value) Object.defineProperty(values, provider, { value, enumerable: false });
  }
  return values;
};
export function settings(
  profile: Record<string, string | boolean | number>,
  credentials: Record<string, string>,
): Settings {
  const rawRoute = stringProfile(profile, "providerRoute") || "exaMcp";
  const route = rawRoute
    .split(",")
    .map((x) => x.trim())
    .filter((x): x is ProviderId => PROVIDERS.includes(x as ProviderId));
  if (
    !route.length ||
    route.length !==
      rawRoute
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean).length
  )
    throw new Error("providerRoute contains an unsupported provider");
  const searxngUrl = stringProfile(profile, "searxngUrl");
  if (searxngUrl) parseSearxngOrigin(searxngUrl);
  return {
    route,
    searxngUrl,
    enableFetch: profile.enableFetch === true,
    credentials: privateCredentials(credentials),
  };
}
export function createTools(config: Settings, fetcher: typeof fetch = fetch): ToolDefinition[] {
  const all = adapters(fetcher);
  const search: ToolDefinition = {
    name: "web_search",
    description:
      "Search the web with the selected provider. The query and optional filters are sent to that remote provider.",
    effect: "external",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        language: { type: "string" },
        country: { type: "string" },
        safeSearch: { type: "boolean" },
        freshness: { type: "string" },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
        provider: { type: "string", enum: PROVIDERS },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      try {
        const parsed = parseSearchInput(input);
        const selected = parsed.provider ? [parsed.provider] : config.route;
        for (const id of selected) {
          const adapter = all[id];
          if (!adapter.active(config)) {
            if (parsed.provider || selected.length === 1)
              throw new Error(`${id} is not configured`);
            continue;
          }
          const results = await adapter.search(parsed, config, context.signal);
          return {
            content: [
              { type: "text", text: markdown(results) },
              {
                type: "ui",
                block: {
                  kind: "table",
                  caption: `Web search via ${id}`,
                  columns: ["Title", "URL", "Provider"],
                  rows: results.map((r) => [r.title, r.url, r.provider]),
                },
              },
            ],
          };
        }
        throw new Error("no configured search provider is available");
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : "web search failed" },
          ],
        };
      }
    },
  };
  const fetchTool: ToolDefinition = {
    name: "web_fetch",
    description:
      "Fetch a public URL through the selected configured provider. The URL is sent to that remote provider; this tool is disabled unless explicitly enabled.",
    effect: "external",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", maxLength: 2048 },
        provider: { type: "string", enum: PROVIDERS },
      },
    },
    async execute(input, context) {
      try {
        if (!config.enableFetch)
          throw new Error(
            "web_fetch is disabled; enableFetch must be set in the non-secret profile",
          );
        const url = await assertPublicUrl(input.url);
        const id = (input.provider as ProviderId | undefined) ?? config.route[0];
        if (!id) throw new Error("no configured fetch provider is available");
        const adapter = all[id];
        if (!adapter?.active(config) || !adapter.fetch)
          throw new Error("the selected provider has no policy-compatible fetch capability");
        const text = await adapter.fetch(url, config, context.signal);
        return { content: [{ type: "text", text: text.slice(0, 20_000) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : "web fetch failed" },
          ],
        };
      }
    },
  };
  return [search, fetchTool];
}
export function createWebSearchPlugin(): Plugin {
  return definePlugin({
    id: "web-search",
    name: "Web Search",
    description: "Provider-neutral external web search and opt-in fetch tools",
    categories: ["search", "tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      const profile = (
        process.env.ALISIO_WEB_SEARCH_PROFILE
          ? JSON.parse(process.env.ALISIO_WEB_SEARCH_PROFILE)
          : {}
      ) as Record<string, string | boolean | number>;
      const config = settings(profile, {});
      for (const tool of createTools(config)) api.tools.register(tool);
    },
  });
}
export { adapters } from "./providers.js";
export { assertPublicUrl, parsePublicUrl, parseSearchInput } from "./validation.js";
export default createWebSearchPlugin();
