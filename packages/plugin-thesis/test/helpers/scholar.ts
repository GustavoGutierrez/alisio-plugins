import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Clock, ScholarClient } from "../../src/research/client.js";

export function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/scholar/${name}`, import.meta.url)),
    "utf8",
  );
}

export interface Route {
  /** Matches when the full request URL contains this text. */
  match: string;
  body?: string;
  status?: number;
  headers?: Record<string, string>;
}

export interface FakeNetwork {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
}

/** A fetch that serves recorded fixtures; any unrouted URL is a test failure (no real network). */
export function fakeNetwork(routes: Route[]): FakeNetwork {
  const calls: FakeNetwork["calls"] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const route = routes.find((entry) => url.includes(entry.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function fakeClock(): Clock & { slept: number[]; time: number } {
  const state = {
    time: 1_000_000,
    slept: [] as number[],
    now() {
      return state.time;
    },
    async sleep(ms: number) {
      state.slept.push(ms);
      state.time += ms;
    },
  };
  return state;
}

/** The recorded-fixture network used by the research tests. */
export const standardRoutes: Route[] = [
  {
    match: "api.crossref.org/works/10.5555/sae.2021.014",
    body: fixture("crossref-work-match.json"),
  },
  {
    match: "api.crossref.org/works/10.5555/soil.2015.099",
    body: fixture("crossref-work-mismatch.json"),
  },
  {
    match: "api.crossref.org/works/10.5555/ret.2020.007",
    body: fixture("crossref-work-retracted.json"),
  },
  {
    match: "api.crossref.org/works/10.5555/book.2018.001",
    body: fixture("crossref-work-book.json"),
  },
  {
    match: "api.crossref.org/works/10.5555/pre.2022.003",
    body: fixture("crossref-work-preprint.json"),
  },
  { match: "api.crossref.org/works?", body: fixture("crossref-search.json") },
  { match: "api.openalex.org/works/W2002", body: fixture("openalex-work-retracted.json") },
  { match: "api.openalex.org/works/W1001", body: fixture("openalex-work-match.json") },
  { match: "api.openalex.org/works?", body: fixture("openalex-search.json") },
  { match: "export.arxiv.org/api/query?search_query", body: fixture("arxiv-search.xml") },
  { match: "export.arxiv.org/api/query?id_list=2203.01234", body: fixture("arxiv-search.xml") },
];

export function fixtureClient(routes: Route[] = standardRoutes, env: NodeJS.ProcessEnv = {}) {
  const network = fakeNetwork(routes);
  const clock = fakeClock();
  const client = new ScholarClient({ fetch: network.fetch, clock, env });
  return { client, network, clock };
}
