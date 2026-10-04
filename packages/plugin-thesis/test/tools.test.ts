import { afterEach, describe, expect, it } from "vitest";
import { cleanup, intakeAnswers, lifecycle } from "./helpers/harness.js";
import { fixtureClient } from "./helpers/scholar.js";

afterEach(cleanup);

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (
  h: Awaited<ReturnType<typeof lifecycle>>,
  name: string,
  input: Record<string, unknown>,
  workspace = h.workspace,
) => {
  const result = (await h.tools
    .get(name)
    ?.execute(input, { workspace, signal: new AbortController().signal } as never)) as Result;
  const raw = result.content[0]?.text ?? "null";
  return { result, data: result.isError ? raw : JSON.parse(raw) };
};

describe("thesis_scholar_search", () => {
  it("is an external tool with a closed input schema", async () => {
    const h = await lifecycle({ interactive: false });
    const tool = h.tools.get("thesis_scholar_search");
    expect(tool?.effect).toBe("external");
    expect(tool?.inputSchema).toMatchObject({
      required: ["query", "source"],
      additionalProperties: false,
    });
  });

  it("returns structured ScholarRecords for each source, capped by limit", async () => {
    const h = await lifecycle({ interactive: false });
    const open = await call(h, "thesis_scholar_search", {
      query: "reference verification",
      source: "openalex",
      limit: 1,
    });
    expect(open.data.results).toHaveLength(1);
    expect(open.data.results[0]).toMatchObject({
      id: "W1001",
      doi: "10.5555/sae.2021.014",
      title: "Automated Verification of Bibliographic References in Academic Writing",
      authors: [
        { family: "Rojas", given: "Ana", orcid: "0000-0002-1825-0097" },
        { family: "Mendoza", given: "Luis", orcid: null },
      ],
      year: 2021,
      containerTitle: "Journal of Scholarly Tools",
      type: "journal_article",
      publisher: "Example Scholarly Press",
      issn: "2345-6789",
      language: "en",
      url: "https://doi.org/10.5555/sae.2021.014",
      oaUrl: "https://example.org/oa/sae-2021.pdf",
      license: "cc-by",
      source: "openalex",
    });
    const crossref = await call(h, "thesis_scholar_search", { query: "x", source: "crossref" });
    expect(crossref.data.results.map((record: { type: string }) => record.type)).toEqual([
      "journal_article",
      "book",
    ]);
    const arxiv = await call(h, "thesis_scholar_search", { query: "x", source: "arxiv" });
    expect(arxiv.data.results[0]).toMatchObject({
      type: "preprint",
      source: "arxiv",
      id: "2203.01234",
    });
  });

  it("strips control characters and caps every string", async () => {
    const long = "L".repeat(5000);
    const body = JSON.stringify({
      message: {
        items: [
          {
            DOI: "10.5555/x.1",
            type: "journal-article",
            title: [`Bad\u0000 title\u001b[31m ${long}`],
            abstract: `<p>${long}</p>`,
            author: [{ family: `Fam\u0007ily${long}`, given: "A\nB" }],
            publisher: long,
            "container-title": [long],
            issued: { "date-parts": [[2020]] },
            URL: "javascript:alert(1)",
          },
        ],
      },
    });
    const h = await lifecycle({
      interactive: false,
      scholar: fixtureClient([{ match: "api.crossref.org", body }]).client,
    });
    const { data, result } = await call(h, "thesis_scholar_search", {
      query: "x",
      source: "crossref",
    });
    const record = data.results[0];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(result.content[0]?.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(record.title.length).toBeLessThanOrEqual(500);
    expect(record.abstract.length).toBeLessThanOrEqual(2000);
    expect(record.authors[0].family.length).toBeLessThanOrEqual(120);
    expect(record.authors[0].given).toBe("A B");
    expect(record.publisher.length).toBeLessThanOrEqual(200);
    expect(record.containerTitle.length).toBeLessThanOrEqual(300);
    expect(record.url).toBe("https://doi.org/10.5555/x.1");
  });

  it("fails with a fixed message on bad input and unavailable sources", async () => {
    const h = await lifecycle({
      interactive: false,
      scholar: fixtureClient([{ match: "", status: 500 }]).client,
    });
    const bad = await call(h, "thesis_scholar_search", { query: "", source: "openalex" });
    expect(bad.result.isError).toBe(true);
    expect(bad.data).toBe("invalid input");
    const down = await call(h, "thesis_scholar_search", { query: "x", source: "openalex" });
    expect(down.result.isError).toBe(true);
    expect(down.data).toBe("source unavailable");
  });
});

describe("thesis_scholar_resolve", () => {
  it("resolves a DOI with its retraction flag and the status verification would assign", async () => {
    const h = await lifecycle({ interactive: false });
    const { data } = await call(h, "thesis_scholar_resolve", {
      identifier: "https://doi.org/10.5555/sae.2021.014",
    });
    expect(data).toMatchObject({
      identifier: { kind: "doi", value: "10.5555/sae.2021.014" },
      record: { doi: "10.5555/sae.2021.014", source: "crossref", year: 2021 },
      retraction: { retracted: false },
      verification: { method: "crossref", suggestedStatus: "VERIFIED_PEER_REVIEWED" },
    });
    const retracted = await call(h, "thesis_scholar_resolve", {
      identifier: "10.5555/ret.2020.007",
    });
    expect(retracted.data).toMatchObject({
      retraction: { retracted: true },
      verification: { suggestedStatus: "REJECTED" },
    });
    const arxiv = await call(h, "thesis_scholar_resolve", { identifier: "arXiv:2203.01234" });
    expect(arxiv.data.verification).toMatchObject({
      method: "arxiv",
      suggestedStatus: "CONTEXTUAL_ONLY",
    });
    const unknown = await call(h, "thesis_scholar_resolve", { identifier: "10.5555/none.9" });
    expect(unknown.data).toMatchObject({
      record: null,
      verification: { suggestedStatus: "UNVERIFIED" },
    });
  });

  it("matches official URLs offline against the policy allowlist of the workspace", async () => {
    const h = await lifecycle({ answers: intakeAnswers });
    await h.run("init", "--lang es-CO");
    const before = h.network.calls.length;
    const official = await call(h, "thesis_scholar_resolve", {
      identifier: "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981",
    });
    expect(official.data).toMatchObject({
      record: null,
      verification: { method: "official_domain", officialDomain: "official" },
    });
    const indexing = await call(h, "thesis_scholar_resolve", {
      identifier: "https://publindex.minciencias.gov.co/x",
    });
    expect(indexing.data.verification.officialDomain).toBe("indexing");
    const other = await call(h, "thesis_scholar_resolve", {
      identifier: "https://example.com/post",
    });
    expect(other.data.verification).toMatchObject({
      officialDomain: "none",
      suggestedStatus: "UNVERIFIED",
    });
    expect(h.network.calls.length).toBe(before);
    // Without a thesis workspace there is no allowlist, so nothing is official.
    const bare = await call(
      h,
      "thesis_scholar_resolve",
      { identifier: "https://www.funcionpublica.gov.co/x" },
      `${h.workspace}-missing`,
    );
    expect(bare.data.verification.officialDomain).toBe("none");
  });

  it("rejects hostile identifiers and extra fields", async () => {
    const h = await lifecycle({ interactive: false });
    for (const input of [
      { identifier: "javascript:alert(1)" },
      { identifier: "https://u:p@x.gov.co/" },
      { identifier: "x", extra: 1 },
      {},
    ]) {
      const { result, data } = await call(h, "thesis_scholar_resolve", input as never);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(["invalid identifier", "invalid input"]).toContain(data);
    }
  });
});
