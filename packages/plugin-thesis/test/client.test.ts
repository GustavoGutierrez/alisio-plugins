import { describe, expect, it } from "vitest";
import {
  limits,
  normalizeArxiv,
  normalizeCrossref,
  normalizeOpenAlex,
  parseIdentifier,
  parseSearchInput,
  ScholarClient,
} from "../src/research/client.js";
import { fakeClock, fakeNetwork, fixture, fixtureClient } from "./helpers/scholar.js";

describe("identifiers and input", () => {
  it("parses DOIs, arXiv ids, OpenAlex ids and URLs", () => {
    expect(parseIdentifier("https://doi.org/10.5555/ABC.1")).toEqual({
      kind: "doi",
      value: "10.5555/abc.1",
    });
    expect(parseIdentifier("doi:10.5555/abc.1")).toEqual({ kind: "doi", value: "10.5555/abc.1" });
    expect(parseIdentifier("arXiv:2203.01234v2")).toEqual({ kind: "arxiv", value: "2203.01234" });
    expect(parseIdentifier("https://arxiv.org/abs/2203.01234")).toEqual({
      kind: "arxiv",
      value: "2203.01234",
    });
    expect(parseIdentifier("https://openalex.org/w1001")).toEqual({
      kind: "openalex",
      value: "W1001",
    });
    expect(
      parseIdentifier("https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=1#top"),
    ).toEqual({
      kind: "url",
      value: "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=1",
    });
  });

  it("rejects hostile identifiers", () => {
    for (const bad of [
      "",
      "javascript:alert(1)",
      "ftp://x.gov.co/a",
      "https://user:pw@x.gov.co/a",
      "x".repeat(3000),
      42,
    ]) {
      expect(() => parseIdentifier(bad), String(bad)).toThrow("invalid identifier");
    }
  });

  it("validates and bounds search input", () => {
    expect(parseSearchInput({ query: " thesis ", source: "openalex" })).toEqual({
      query: "thesis",
      source: "openalex",
      limit: 10,
    });
    expect(
      parseSearchInput({
        query: "a",
        source: "arxiv",
        limit: 25,
        fromYear: 2018,
        toYear: 2020,
        language: "ES",
      }),
    ).toMatchObject({
      limit: 25,
      language: "es",
    });
    for (const bad of [
      {},
      { query: "", source: "openalex" },
      { query: "a", source: "scholar" },
      { query: "a", source: "openalex", limit: 26 },
      { query: "a", source: "openalex", fromYear: 2021, toYear: 2020 },
      { query: "a".repeat(513), source: "openalex" },
      { query: "a", source: "openalex", extra: 1 },
    ]) {
      expect(() => parseSearchInput(bad)).toThrow("invalid input");
    }
  });
});

describe("normalizers", () => {
  it("normalizes Crossref and strips markup and control characters", () => {
    const item = JSON.parse(fixture("crossref-work-match.json")).message;
    const { record, retracted } = normalizeCrossref(item) ?? {};
    expect(retracted).toBe(false);
    expect(record).toMatchObject({
      id: "10.5555/sae.2021.014",
      doi: "10.5555/sae.2021.014",
      year: 2021,
      type: "journal_article",
      containerTitle: "Journal of Scholarly Tools",
      pages: "211-230",
      source: "crossref",
      authors: [
        { family: "Rojas", given: "Ana", orcid: "0000-0002-1825-0097" },
        { family: "Mendoza", given: "Luis", orcid: null },
      ],
    });
    expect(record?.abstract).toBe("We study how reference checking can be automated & audited.");
  });

  it("detects retraction in Crossref and OpenAlex", () => {
    const crossref = normalizeCrossref(JSON.parse(fixture("crossref-work-retracted.json")).message);
    expect(crossref?.retracted).toBe(true);
    const openalex = normalizeOpenAlex(JSON.parse(fixture("openalex-work-retracted.json")));
    expect(openalex?.retracted).toBe(true);
  });

  it("normalizes OpenAlex, rebuilding abstracts and dropping unsafe URLs", () => {
    const [first, second] = JSON.parse(fixture("openalex-search.json")).results.map(
      normalizeOpenAlex,
    );
    expect(first.record).toMatchObject({
      id: "W1001",
      doi: "10.5555/sae.2021.014",
      abstract: "We study reference checking",
      oaUrl: "https://example.org/oa/sae-2021.pdf",
      pages: "211-230",
      type: "journal_article",
    });
    expect(second.record.type).toBe("conference_paper");
    expect(second.record.url).toBeNull();
  });

  it("normalizes arXiv feeds", () => {
    const records = normalizeArxiv(fixture("arxiv-search.xml"));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "2203.01234",
      doi: "10.5555/pre.2022.003",
      type: "preprint",
      year: 2022,
      abstract:
        "We test whether language models can flag unsupported citations & fabricated references.",
    });
    expect(records[1]?.title).toBe("Evidence Graphs for Thesis Writing");
  });

  it("caps long fields", () => {
    const item = {
      DOI: "10.5555/x.1",
      title: ["t".repeat(900)],
      abstract: "a".repeat(5000),
      author: Array.from({ length: 80 }, (_, index) => ({ family: `F${index}` })),
      issued: { "date-parts": [[2020]] },
      type: "journal-article",
    };
    const record = normalizeCrossref(item)?.record;
    expect(record?.title).toHaveLength(500);
    expect(record?.abstract).toHaveLength(2000);
    expect(record?.authors).toHaveLength(50);
  });
});

describe("ScholarClient", () => {
  it("searches the three fixed origins with the documented filters", async () => {
    const { client, network } = fixtureClient();
    const open = await client.search({
      query: "reference verification",
      source: "openalex",
      limit: 5,
      fromYear: 2019,
      toYear: 2021,
      language: "en",
    });
    expect(open.map((record) => record.id)).toEqual(["W1001", "W1002"]);
    const crossref = await client.search({
      query: "reference verification",
      source: "crossref",
      limit: 5,
      fromYear: 2019,
    });
    expect(crossref.map((record) => record.doi)).toEqual(["10.5555/sae.2021.014"]);
    const arxiv = await client.search({
      query: "citation checking",
      source: "arxiv",
      limit: 5,
      toYear: 2022,
    });
    expect(arxiv.map((record) => record.id)).toEqual(["2203.01234"]);

    const urls = network.calls.map((call) => new URL(call.url));
    expect(urls.map((url) => url.origin)).toEqual([
      "https://api.openalex.org",
      "https://api.crossref.org",
      "https://export.arxiv.org",
    ]);
    expect(urls[0]?.searchParams.get("filter")).toBe(
      "from_publication_date:2019-01-01,to_publication_date:2021-12-31,language:en",
    );
    expect(urls[1]?.searchParams.get("filter")).toBe("from-pub-date:2019");
    for (const call of network.calls) expect(call.init?.redirect).toBe("manual");
  });

  it("resolves DOIs on Crossref, falls back to OpenAlex, and handles arXiv ids", async () => {
    const { client } = fixtureClient();
    const crossref = await client.resolve({ kind: "doi", value: "10.5555/sae.2021.014" });
    expect(crossref?.record.source).toBe("crossref");
    expect((await client.resolve({ kind: "arxiv", value: "2203.01234" }))?.record.id).toBe(
      "2203.01234",
    );
    expect((await client.resolve({ kind: "openalex", value: "W2002" }))?.retracted).toBe(true);
    expect(await client.resolve({ kind: "url", value: "https://x.gov.co/a" })).toBeUndefined();

    const fallback = fixtureClient([
      { match: "api.openalex.org/works/doi:", body: fixture("openalex-work-match.json") },
    ]);
    const viaOpenAlex = await fallback.client.resolve({
      kind: "doi",
      value: "10.5555/sae.2021.014",
    });
    expect(viaOpenAlex?.record.source).toBe("openalex");
    const unknown = await fixtureClient([]).client.resolve({
      kind: "doi",
      value: "10.5555/none.1",
    });
    expect(unknown).toBeUndefined();
  });

  it("rejects redirects, rate limits, bad status and oversize bodies with fixed messages", async () => {
    const make = (status: number, body = "", headers?: Record<string, string>) =>
      new ScholarClient({
        fetch: fakeNetwork([{ match: "api.", status, body, ...(headers ? { headers } : {}) }])
          .fetch,
        env: {},
      });
    const input = { query: "x", source: "openalex" as const, limit: 1 };
    await expect(
      make(302, "", { location: "https://evil.example/" }).search(input),
    ).rejects.toThrow("source returned redirect");
    await expect(make(429).search(input)).rejects.toThrow("source rate limited");
    await expect(make(500).search(input)).rejects.toThrow("source unavailable");
    await expect(make(200, "x".repeat(limits.responseBytes + 1)).search(input)).rejects.toThrow(
      "response exceeded limit",
    );
    await expect(make(200, "not json").search(input)).rejects.toThrow("source unavailable");
  });

  it("times out slow sources", async () => {
    const slow = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const client = new ScholarClient({ fetch: slow, timeoutMs: 20, env: {} });
    await expect(client.search({ query: "x", source: "openalex", limit: 1 })).rejects.toThrow(
      "source unavailable",
    );
  });

  it("keeps a single Crossref request in flight", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(fixture("crossref-work-match.json"));
    }) as unknown as typeof fetch;
    const client = new ScholarClient({ fetch: fetcher, env: {} });
    await Promise.all(
      [1, 2, 3, 4].map(() => client.resolve({ kind: "doi", value: "10.5555/sae.2021.014" })),
    );
    expect(peak).toBe(1);
  });

  it("spaces arXiv requests by three seconds", async () => {
    const network = fakeNetwork([{ match: "export.arxiv.org", body: fixture("arxiv-search.xml") }]);
    const clock = fakeClock();
    const client = new ScholarClient({ fetch: network.fetch, clock, env: {} });
    await client.search({ query: "a", source: "arxiv", limit: 1 });
    await client.search({ query: "b", source: "arxiv", limit: 1 });
    await client.search({ query: "c", source: "arxiv", limit: 1 });
    expect(clock.slept).toEqual([3000, 3000]);
  });

  it("uses the contact email only as a polite-pool parameter and never leaks it", async () => {
    const env = { ALISIO_THESIS_CONTACT_EMAIL: "someone@example.org" };
    const { client, network } = fixtureClient(undefined, env);
    await client.search({ query: "x", source: "openalex", limit: 1 });
    await client.resolve({ kind: "doi", value: "10.5555/sae.2021.014" });
    expect(new URL(network.calls[0]?.url as string).searchParams.get("mailto")).toBe(
      "someone@example.org",
    );
    expect(JSON.stringify(network.calls[1]?.init?.headers)).toContain("mailto:someone@example.org");
    const failing = new ScholarClient({
      fetch: fakeNetwork([{ match: "api.", status: 500 }]).fetch,
      env,
    });
    const error = await failing
      .search({ query: "x", source: "openalex", limit: 1 })
      .catch((e: Error) => e);
    expect((error as Error).message).not.toContain("example.org");
    const without = fixtureClient();
    await without.client.search({ query: "x", source: "openalex", limit: 1 });
    expect(without.network.calls[0]?.url).not.toContain("mailto");
  });

  it("ignores a malformed contact email", async () => {
    const { client, network } = fixtureClient(undefined, {
      ALISIO_THESIS_CONTACT_EMAIL: "not an email",
    });
    await client.search({ query: "x", source: "openalex", limit: 1 });
    expect(network.calls[0]?.url).not.toContain("mailto");
  });
});
