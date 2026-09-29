import { definePlugin, type Plugin, type ToolDefinition, type ToolResult } from "@alisio/sdk";
import { type Clock, request } from "./client.js";
import { type Identifier, readInput, type Source, searchInput } from "./validation.js";
export const VERSION = "0.1.0";
type Paper = {
  id: string;
  title?: string | undefined;
  authors: string[];
  date?: string | undefined;
  venue?: string | undefined;
  abstract?: string | undefined;
  url?: string | undefined;
  oa?: string | undefined;
  license?: string | undefined;
  source: Source;
};
const clean = (v: unknown, max = 2000) =>
  typeof v === "string"
    ? v
        .replace(/[\s\S]/g, (character) => {
          const point = character.codePointAt(0) ?? 0;
          return point < 32 || point === 127 ? " " : character;
        })
        .replace(/[\\`*_{}[\]()<>#+.!|-]/g, "\\$&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : undefined;
const arr = (v: unknown) =>
  Array.isArray(v)
    ? v
        .slice(0, 20)
        .map((x) => clean(typeof x === "string" ? x : (x as { name?: unknown })?.name, 200))
        .filter((x): x is string => Boolean(x))
    : [];
function openalex(v: Record<string, unknown>): Paper {
  const inv = v.abstract_inverted_index as Record<string, number[]> | undefined;
  const abstract = inv
    ? Object.entries(inv)
        .flatMap(([word, positions]) => positions.map((position) => [position, word] as const))
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[1])
        .join(" ")
    : undefined;
  const loc = v.primary_location as Record<string, unknown> | undefined;
  return {
    id: String(v.id ?? "").replace("https://openalex.org/", ""),
    title: clean(v.title),
    authors: arr(
      ((v.authorships as unknown[]) ?? []).map(
        (x) => (x as { author?: { display_name?: unknown } }).author?.display_name,
      ),
    ),
    date: clean(v.publication_date, 32),
    venue: clean((loc?.source as { display_name?: unknown })?.display_name, 300),
    abstract: clean(abstract, 20000),
    url: clean(v.doi, 2048),
    oa:
      v.open_access && typeof v.open_access === "object"
        ? (v.open_access as { is_oa?: unknown }).is_oa === true
          ? "open access"
          : undefined
        : undefined,
    source: "openalex",
  };
}
function crossref(v: Record<string, unknown>): Paper {
  const date = (v.published as { "date-parts"?: number[][] } | undefined)?.[
    "date-parts"
  ]?.[0]?.join("-");
  return {
    id: clean(v.DOI, 2048) ?? "",
    title: clean((v.title as unknown[])?.[0]),
    authors: arr(
      ((v.author as unknown[]) ?? []).map((author) => {
        const item = author as { name?: unknown; given?: unknown; family?: unknown };
        return (
          item.name ??
          [item.given, item.family].filter((part) => typeof part === "string").join(" ")
        );
      }),
    ),
    date,
    venue: clean((v["container-title"] as unknown[])?.[0], 300),
    abstract: clean(v.abstract, 20000),
    url: clean(v.URL, 2048),
    license: clean((v.license as { URL?: unknown }[] | undefined)?.[0]?.URL, 2048),
    source: "crossref",
  };
}
function arxiv(xml: string): Paper[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1] ?? "");
  return entries.map((e) => ({
    id: e.match(/<id>[^<]*\/abs\/([^<]+)<\/id>/)?.[1] ?? "",
    title: clean(e.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
    authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)]
      .map((m) => clean(m[1], 200))
      .filter((x): x is string => Boolean(x))
      .slice(0, 20),
    date: clean(e.match(/<published>(\d{4}-\d{2}-\d{2})/)?.[1], 32),
    abstract: clean(e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1], 20000),
    url: undefined,
    source: "arxiv",
  }));
}
function paths(source: Source, q: string, limit: number, from?: number, to?: number) {
  const f = encodeURIComponent(q);
  if (source === "openalex")
    return `/works?search=${f}&per-page=${limit}${from ? `&filter=from_publication_date:${from}-01-01${to ? `,to_publication_date:${to}-12-31` : ""}` : ""}`;
  if (source === "crossref")
    return `/works?query=${f}&rows=${limit}${from ? `&filter=from-pub-date:${from}-01-01${to ? `,until-pub-date:${to}-12-31` : ""}` : ""}`;
  return `/api/query?search_query=all:${f}&start=0&max_results=${limit}`;
}
function markdown(papers: Paper[], label: string) {
  return [
    `${label}. Outbound request: ${[...new Set(papers.map((p) => p.source))].join(", ") || "none"}.`,
    ...papers.map(
      (p, i) =>
        `${i + 1}. **${p.title ?? "Untitled"}** — ${p.authors.join(", ") || "Unknown authors"}${p.date ? ` (${p.date})` : ""}\n   ID: ${p.id}; source: ${p.source}${p.abstract ? `\n   Abstract: ${p.abstract.slice(0, 20000)}` : ""}`,
    ),
  ]
    .join("\n")
    .slice(0, 20000);
}
async function find(
  source: Source,
  q: string,
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
  clock?: Clock,
  from?: number,
  to?: number,
) {
  const body = await request(source, paths(source, q, limit, from, to), fetcher, signal, clock);
  try {
    if (source === "arxiv") return arxiv(body).slice(0, limit);
    const data = JSON.parse(body);
    return source === "openalex"
      ? ((data.results ?? []) as Record<string, unknown>[]).map(openalex).slice(0, limit)
      : ((data.message?.items ?? []) as Record<string, unknown>[]).map(crossref).slice(0, limit);
  } catch {
    throw new Error("invalid source response");
  }
}
async function get(id: Identifier, signal: AbortSignal, fetcher: typeof fetch, clock?: Clock) {
  if (id.kind === "openalex")
    return findOne("openalex", `/works/${id.value}`, signal, fetcher, clock);
  if (id.kind === "doi")
    return findOne("crossref", `/works/${encodeURIComponent(id.value)}`, signal, fetcher, clock);
  const data = await request(
    "arxiv",
    `/api/query?id_list=${encodeURIComponent(id.value + (id.version ? `v${id.version}` : ""))}`,
    fetcher,
    signal,
    clock,
  );
  const p = arxiv(data)[0];
  if (!p) throw new Error("invalid source response");
  return p;
}
async function findOne(
  source: Source,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  clock?: Clock,
) {
  const body = await request(source, path, fetcher, signal, clock);
  try {
    const d = JSON.parse(body);
    return source === "openalex" ? openalex(d) : crossref(d.message);
  } catch {
    throw new Error("invalid source response");
  }
}
export function createTools(fetcher: typeof fetch = fetch, clock?: Clock): ToolDefinition[] {
  const execute =
    (fn: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>) =>
    async (i: Record<string, unknown>, c: { signal: AbortSignal }): Promise<ToolResult> => {
      try {
        return await fn(i, c.signal);
      } catch (e) {
        const message =
          e instanceof Error &&
          [
            "invalid input",
            "source unavailable",
            "source rate limited",
            "invalid source response",
            "response exceeded limit",
            "source returned redirect",
          ].includes(e.message)
            ? e.message
            : "source unavailable";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    };
  return [
    {
      name: "literature_search",
      description:
        "Search OpenAlex scholarly metadata. Sends the topic only to OpenAlex; no URLs, PDFs, full text, or page reading.",
      effect: "external",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          fromYear: { type: "integer" },
          toYear: { type: "integer" },
        },
      },
      execute: execute(async (i, s) => {
        const x = searchInput(i);
        const p = await find("openalex", x.query, x.limit, s, fetcher, clock, x.fromYear, x.toYear);
        return { content: [{ type: "text", text: markdown(p, "OpenAlex search") }] };
      }),
    },
    {
      name: "paper_discover",
      description:
        "Discover scholarly metadata from a fixed official source. Sends the topic to OpenAlex, Crossref, or arXiv only; no URLs, PDFs, full text, or page reading.",
      effect: "external",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query", "source"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512 },
          source: { type: "string", enum: ["openalex", "crossref", "arxiv"] },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          fromYear: { type: "integer" },
          toYear: { type: "integer" },
        },
      },
      execute: execute(async (i, s) => {
        const x = searchInput(i, true);
        const p = await find(x.source, x.query, x.limit, s, fetcher, clock, x.fromYear, x.toYear);
        return { content: [{ type: "text", text: markdown(p, `${x.source} discovery`) }] };
      }),
    },
    {
      name: "literature_read",
      description:
        "Read normalized metadata and a bounded source-provided abstract for exactly one DOI, arXiv ID, or OpenAlex work ID. It sends the identifier to its fixed official source; never reads URLs, PDFs, landing pages, HTML, or full text.",
      effect: "external",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["identifier"],
        properties: { identifier: { type: "string", minLength: 1, maxLength: 2048 } },
      },
      execute: execute(async (i, s) => {
        const p = await get(readInput(i), s, fetcher, clock);
        return { content: [{ type: "text", text: markdown([p], `${p.source} metadata read`) }] };
      }),
    },
  ];
}
export function createLiteratureResearchPlugin(): Plugin {
  return definePlugin({
    id: "literature-research",
    name: "Literature Research",
    description: "Safe scholarly metadata and abstract research",
    categories: ["search", "tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      for (const tool of createTools()) api.tools.register(tool);
    },
  });
}
export { identifier, readInput, searchInput } from "./validation.js";
export default createLiteratureResearchPlugin();
