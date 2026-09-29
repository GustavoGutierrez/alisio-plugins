import type { ProviderId, SearchInput, SearchItem } from "./validation.js";
import { cleanText, item } from "./validation.js";

export type FetchLike = typeof fetch;
export type Settings = {
  route: ProviderId[];
  searxngUrl?: string | undefined;
  enableFetch: boolean;
  credentials: Partial<Record<Exclude<ProviderId, "exaMcp" | "searxng">, string | undefined>>;
};
export type Adapter = {
  id: ProviderId;
  active(settings: Settings): boolean;
  search(input: SearchInput, settings: Settings, signal: AbortSignal): Promise<SearchItem[]>;
  fetch?(url: URL, settings: Settings, signal: AbortSignal): Promise<string>;
};
const deadline = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
async function json(fetcher: FetchLike, url: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetcher(url, { ...init, signal: deadline(signal), redirect: "error" });
  if (response.status === 429)
    throw new Error("provider rate limited this request; try again later");
  if (!response.ok)
    throw new Error(
      response.status >= 500
        ? "provider is temporarily unavailable"
        : "provider rejected the request",
    );
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 1_048_576) throw new Error("provider response is too large");
  return response.json() as Promise<unknown>;
}
async function readText(fetcher: FetchLike, url: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetcher(url, { ...init, signal: deadline(signal), redirect: "error" });
  if (response.status === 429)
    throw new Error("provider rate limited this request; try again later");
  if (!response.ok)
    throw new Error(
      response.status >= 500
        ? "provider is temporarily unavailable"
        : "provider rejected the request",
    );
  if (Number(response.headers.get("content-length") ?? 0) > 1_048_576)
    throw new Error("provider response is too large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > 1_048_576) {
      await reader.cancel();
      throw new Error("provider response is too large");
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
const list = (values: unknown[], provider: ProviderId) =>
  values
    .map((value) =>
      typeof value === "object" && value
        ? item(value as Record<string, unknown>, provider)
        : undefined,
    )
    .filter((x): x is SearchItem => Boolean(x));
const key = (settings: Settings, id: Exclude<ProviderId, "exaMcp" | "searxng">) =>
  settings.credentials[id];

export function adapters(fetcher: FetchLike = fetch): Record<ProviderId, Adapter> {
  const exaMcp: Adapter = {
    id: "exaMcp",
    active: () => true,
    async search(input, _settings, signal) {
      const call = async (method: string, params: Record<string, unknown>, session?: string) => {
        const response = await fetcher("https://mcp.exa.ai/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: deadline(signal),
          redirect: "error",
        });
        if (response.status === 429)
          throw new Error("provider rate limited this request; try again later");
        if (!response.ok)
          throw new Error(
            response.status >= 500
              ? "provider is temporarily unavailable"
              : "provider protocol request failed",
          );
        if (Number(response.headers.get("content-length") ?? 0) > 1_048_576)
          throw new Error("provider response is too large");
        const body = await response.text();
        const jsonText = response.headers.get("content-type")?.includes("text/event-stream")
          ? body
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .find((line) => line !== "[DONE]")
          : body;
        if (!jsonText) throw new Error("provider returned an empty protocol response");
        let data: unknown;
        try {
          data = JSON.parse(jsonText);
        } catch {
          throw new Error("provider returned malformed protocol data");
        }
        if (
          !data ||
          typeof data !== "object" ||
          (data as Record<string, unknown>).jsonrpc !== "2.0"
        )
          throw new Error("provider returned an incompatible protocol response");
        return {
          data: data as Record<string, unknown>,
          session: response.headers.get("mcp-session-id") ?? session,
        };
      };
      const initialized = await call("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "alisio-web-search", version: "0.1.0" },
      });
      const session = initialized.session;
      await call("notifications/initialized", {}, session);
      const tools = (await call("tools/list", {}, session)).data;
      const toolList = (tools.result as Record<string, unknown> | undefined)?.tools;
      const found =
        Array.isArray(toolList) &&
        toolList.some(
          (tool: unknown) =>
            typeof tool === "object" &&
            tool !== null &&
            (tool as Record<string, unknown>).name === "web_search_exa",
        );
      if (!found) throw new Error("provider protocol does not offer web search");
      const response = (
        await call(
          "tools/call",
          {
            name: "web_search_exa",
            arguments: { query: input.query, numResults: input.maxResults },
          },
          session,
        )
      ).data;
      const content = (response.result as Record<string, unknown> | undefined)?.content;
      const text = Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "object" && part ? (part as Record<string, unknown>).text : "",
            )
            .filter((part): part is string => typeof part === "string")
            .join("\n")
        : "";
      try {
        const parsed = JSON.parse(text) as unknown;
        const results = Array.isArray(parsed)
          ? parsed
          : (parsed as { results?: unknown[] }).results;
        return list(
          Array.isArray(results)
            ? results.map((x) => {
                const o = x as Record<string, unknown>;
                return {
                  title: o.title,
                  url: o.url,
                  snippet: o.text ?? o.snippet,
                  date: o.publishedDate,
                  score: o.score,
                };
              })
            : [],
          "exaMcp",
        ).slice(0, input.maxResults);
      } catch {
        throw new Error("provider returned malformed search results");
      }
    },
    async fetch(url, _settings, signal) {
      let session: string | undefined;
      const call = async (method: string, params: Record<string, unknown>) => {
        const response = await fetcher("https://mcp.exa.ai/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: deadline(signal),
          redirect: "error",
        });
        if (response.status === 429)
          throw new Error("provider rate limited this request; try again later");
        if (!response.ok) throw new Error("provider protocol request failed");
        const body = await response.text();
        const payload = response.headers.get("content-type")?.includes("text/event-stream")
          ? body
              .split("\n")
              .find((line) => line.startsWith("data:"))
              ?.slice(5)
              .trim()
          : body;
        try {
          const value = JSON.parse(payload ?? "") as Record<string, unknown>;
          if (value.jsonrpc !== "2.0") throw new Error();
          session = response.headers.get("mcp-session-id") ?? session;
          return value;
        } catch {
          throw new Error("provider returned malformed protocol data");
        }
      };
      await call("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "alisio-web-search", version: "0.1.0" },
      });
      await call("notifications/initialized", {});
      const discovered = await call("tools/list", {});
      const available = (discovered.result as Record<string, unknown> | undefined)?.tools;
      if (
        !Array.isArray(available) ||
        !available.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>).name === "web_fetch_exa",
        )
      )
        throw new Error("provider has no policy-compatible fetch capability");
      const result = await call("tools/call", {
        name: "web_fetch_exa",
        arguments: { url: url.toString() },
      });
      const content = (result.result as Record<string, unknown> | undefined)?.content;
      const output = cleanText(
        Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === "object" && part ? (part as Record<string, unknown>).text : "",
              )
              .filter((part): part is string => typeof part === "string")
              .join("\n")
          : "",
        20_000,
      );
      if (!output) throw new Error("provider returned no valid fetched text");
      return output;
    },
  };
  const searxng: Adapter = {
    id: "searxng",
    active: (s) => Boolean(s.searxngUrl),
    async search(input, settings, signal) {
      const url = new URL("/search", settings.searxngUrl);
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", "1");
      if (input.language) url.searchParams.set("language", input.language);
      if (input.safeSearch !== undefined)
        url.searchParams.set("safesearch", input.safeSearch ? "1" : "0");
      const data = (await json(
        fetcher,
        url.toString(),
        { headers: { accept: "application/json" } },
        signal,
      )) as { results?: unknown[] };
      return list(
        (data.results ?? []).map((x) => {
          const o = x as Record<string, unknown>;
          return {
            title: o.title,
            url: o.url,
            snippet: o.content,
            date: o.publishedDate,
            siteName: o.engine,
          };
        }),
        "searxng",
      ).slice(0, input.maxResults);
    },
  };
  const restful = (id: Exclude<ProviderId, "exaMcp" | "searxng">): Adapter => ({
    id,
    active: (s) => Boolean(key(s, id)),
    async search(input, settings, signal) {
      const credential = key(settings, id);
      if (!credential) throw new Error("provider is not configured");
      let data: unknown;
      if (id === "brave") {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", input.query);
        url.searchParams.set("count", String(input.maxResults));
        if (input.country) url.searchParams.set("country", input.country);
        if (input.safeSearch !== undefined)
          url.searchParams.set("safesearch", input.safeSearch ? "strict" : "off");
        data = await json(
          fetcher,
          url.toString(),
          { headers: { accept: "application/json", "x-subscription-token": credential } },
          signal,
        );
        return list(
          (((data as { web?: { results?: unknown[] } }).web?.results ?? []) as unknown[]).map(
            (x) => {
              const o = x as Record<string, unknown>;
              return { title: o.title, url: o.url, snippet: o.description, date: o.age };
            },
          ),
          id,
        ).slice(0, input.maxResults);
      }
      if (id === "tavily")
        data = await json(
          fetcher,
          "https://api.tavily.com/search",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: credential,
              query: input.query,
              max_results: input.maxResults,
              search_depth: "basic",
            }),
          },
          signal,
        );
      else if (id === "firecrawl")
        data = await json(
          fetcher,
          "https://api.firecrawl.dev/v2/search",
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
            body: JSON.stringify({ query: input.query, limit: input.maxResults }),
          },
          signal,
        );
      else if (id === "exaApi")
        data = await json(
          fetcher,
          "https://api.exa.ai/search",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": credential },
            body: JSON.stringify({ query: input.query, numResults: input.maxResults }),
          },
          signal,
        );
      else
        data = await json(
          fetcher,
          `https://s.jina.ai/?q=${encodeURIComponent(input.query)}`,
          { headers: { authorization: `Bearer ${credential}`, accept: "application/json" } },
          signal,
        );
      const root = data as { results?: unknown[]; data?: unknown[] };
      return list(
        (root.results ?? root.data ?? []).map((x) => {
          const o = x as Record<string, unknown>;
          return {
            title: o.title ?? o.name,
            url: o.url ?? o.link,
            snippet: o.content ?? o.snippet ?? o.text,
            date: o.published_date,
            score: o.score,
          };
        }),
        id,
      ).slice(0, input.maxResults);
    },
    async fetch(url, settings, signal) {
      const credential = key(settings, id);
      if (!credential || !["tavily", "jina", "firecrawl"].includes(id))
        throw new Error("the selected provider has no policy-compatible fetch capability");
      let data: unknown;
      if (id === "tavily")
        data = await json(
          fetcher,
          "https://api.tavily.com/extract",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ api_key: credential, urls: [url.toString()] }),
          },
          signal,
        );
      else if (id === "firecrawl")
        data = await json(
          fetcher,
          "https://api.firecrawl.dev/v2/scrape",
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
            body: JSON.stringify({ url: url.toString(), formats: ["markdown"] }),
          },
          signal,
        );
      else
        data = {
          content: await readText(
            fetcher,
            `https://r.jina.ai/${url.toString()}`,
            { headers: { authorization: `Bearer ${credential}`, accept: "text/plain" } },
            signal,
          ),
        };
      const root = data as {
        results?: Array<{ raw_content?: unknown }>;
        data?: { markdown?: unknown; content?: unknown };
        content?: unknown;
      };
      const text =
        id === "tavily"
          ? root.results?.[0]?.raw_content
          : id === "firecrawl"
            ? (root.data?.markdown ?? root.data?.content)
            : root.content;
      const output = cleanText(text, 20_000);
      if (!output) throw new Error("provider returned no valid fetched text");
      return output;
    },
  });
  return {
    exaMcp,
    searxng,
    brave: restful("brave"),
    tavily: restful("tavily"),
    jina: restful("jina"),
    firecrawl: restful("firecrawl"),
    exaApi: restful("exaApi"),
  };
}
export function markdown(results: SearchItem[]) {
  return (
    results
      .map(
        (r, i) =>
          `${i + 1}. [${r.title}](${r.url})${r.snippet ? ` — ${r.snippet}` : ""}\n   Provider: ${r.provider}`,
      )
      .join("\n\n") || "No valid public results were returned."
  );
}
export const fetchedText = (value: unknown) => cleanText(value, 20_000) ?? "";
