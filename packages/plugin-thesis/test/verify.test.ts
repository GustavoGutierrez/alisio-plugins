import { describe, expect, it } from "vitest";
import type { ComplianceProfile } from "../src/policy/resolver.js";
import {
  applyAuditorStatus,
  classifyHost,
  type OfficialDomains,
  officialDomainsFromProfile,
  titleSimilarity,
  verifyCandidate,
} from "../src/research/verify.js";
import { fixture, fixtureClient, standardRoutes } from "./helpers/scholar.js";

const now = () => new Date("2026-10-04T12:00:00Z");
const domains: OfficialDomains = {
  primary: [
    {
      hosts: ["gov.co", "funcionpublica.gov.co", "comunidadandina.org"],
      allowedTypes: ["law", "standard", "report", "dataset"],
    },
    { hosts: ["icontec.org"], allowedTypes: ["standard"] },
  ],
  indexing: ["scielo.org.co", "publindex.minciencias.gov.co"],
};

const rojas = {
  identifier: "10.5555/sae.2021.014",
  title: "Automated verification of bibliographic references in academic writing",
  firstAuthor: "Rojas",
  year: 2021,
};

function context(routes = standardRoutes) {
  const { client, network } = fixtureClient(routes);
  return { client, network, ctx: { client, domains, now } };
}

describe("title similarity", () => {
  it("folds accents and case and drops stop words per language", () => {
    expect(
      titleSimilarity(
        "Evaluación de la Arquitectura del Software",
        "evaluacion arquitectura software",
        "es",
      ),
    ).toBe(1);
    expect(titleSimilarity("The Study of Soil", "Study Soil", "en")).toBe(1);
    expect(titleSimilarity("Redes neuronales", "Soil moisture dynamics")).toBe(0);
  });
});

describe("DOI verification", () => {
  it("accepts a DOI whose metadata matches as VERIFIED_PEER_REVIEWED", async () => {
    const { ctx } = context();
    const result = await verifyCandidate(rojas, ctx);
    expect(result.status).toBe("VERIFIED_PEER_REVIEWED");
    expect(result.record).toMatchObject({
      type: "journal_article",
      year: 2021,
      doi: "10.5555/sae.2021.014",
      verification: {
        method: "crossref",
        retracted: false,
        metadataMatch: 1,
        checkedAt: "2026-10-04T12:00:00.000Z",
      },
    });
  });

  it("tolerates a title with a different case, accents and a year within one", async () => {
    const { ctx } = context();
    const result = await verifyCandidate(
      {
        ...rojas,
        title: "AUTOMATED VERIFICATION OF BIBLIOGRAPHIC REFERENCES IN ACADEMIC WRITING.",
        year: 2022,
      },
      ctx,
    );
    expect(result.status).toBe("VERIFIED_PEER_REVIEWED");
  });

  it("marks a DOI that resolves to a different work as UNVERIFIED (doi_mismatch)", async () => {
    const { ctx } = context();
    const result = await verifyCandidate({ ...rojas, identifier: "10.5555/soil.2015.099" }, ctx);
    expect(result).toMatchObject({ status: "UNVERIFIED", reason: "doi_mismatch" });
    expect(result.detail).toMatch(/similarity/);
  });

  it("marks wrong first author or year beyond one as UNVERIFIED", async () => {
    const { ctx } = context();
    expect((await verifyCandidate({ ...rojas, firstAuthor: "Mendoza" }, ctx)).detail).toBe(
      "first author does not match",
    );
    expect((await verifyCandidate({ ...rojas, year: 2019 }, ctx)).reason).toBe("doi_mismatch");
    expect((await verifyCandidate({ ...rojas, firstAuthor: null }, ctx)).status).toBe("UNVERIFIED");
  });

  it("marks an unknown DOI and an unreachable source UNVERIFIED without throwing", async () => {
    const { ctx } = context([]);
    expect(await verifyCandidate({ ...rojas, identifier: "10.5555/none.1" }, ctx)).toMatchObject({
      status: "UNVERIFIED",
      reason: "doi_not_found",
    });
    const failing = context([{ match: "api.", status: 500 }]);
    expect(await verifyCandidate(rojas, failing.ctx)).toMatchObject({
      status: "UNVERIFIED",
      reason: "source_unavailable",
    });
    expect(await verifyCandidate({ ...rojas, identifier: "not-an-id" }, ctx)).toMatchObject({
      reason: "invalid_identifier",
    });
  });

  it("rejects retracted works from Crossref updated-by metadata", async () => {
    const { ctx } = context();
    const result = await verifyCandidate(
      {
        identifier: "10.5555/ret.2020.007",
        title: "A neural approach to reference matching",
        firstAuthor: "Salazar",
        year: 2020,
      },
      ctx,
    );
    expect(result).toMatchObject({ status: "REJECTED", reason: "retracted" });
    expect(result.record?.verification.retracted).toBe(true);
  });

  it("rejects retracted works reported only by OpenAlex is_retracted", async () => {
    const { ctx } = context([
      {
        match: "api.crossref.org/works/10.5555/sae.2021.014",
        body: fixture("crossref-work-match.json"),
      },
      {
        match: "api.openalex.org/works/doi:",
        body: JSON.stringify({
          ...JSON.parse(fixture("openalex-work-match.json")),
          is_retracted: true,
        }),
      },
    ]);
    expect(await verifyCandidate(rojas, ctx)).toMatchObject({
      status: "REJECTED",
      reason: "retracted",
    });
    const directly = await verifyCandidate(
      {
        identifier: "W2002",
        title: "A neural approach to reference matching",
        firstAuthor: "Salazar",
        year: 2020,
      },
      context().ctx,
    );
    expect(directly).toMatchObject({ status: "REJECTED", reason: "retracted" });
  });

  it("classifies books as authoritative grey and preprints as contextual", async () => {
    const { ctx } = context();
    const book = await verifyCandidate(
      {
        identifier: "10.5555/book.2018.001",
        title: "Research methods for software engineering",
        firstAuthor: "Vega",
        year: 2018,
      },
      ctx,
    );
    expect(book.status).toBe("VERIFIED_AUTHORITATIVE_GREY");
    const preprint = await verifyCandidate(
      {
        identifier: "10.5555/pre.2022.003",
        title: "Language models for citation checking",
        firstAuthor: "Petrov",
        year: 2022,
      },
      ctx,
    );
    expect(preprint.status).toBe("CONTEXTUAL_ONLY");
    const arxiv = await verifyCandidate(
      {
        identifier: "arXiv:2203.01234",
        title: "Language models for citation checking",
        firstAuthor: "Petrov",
        year: 2022,
      },
      ctx,
    );
    expect(arxiv).toMatchObject({
      status: "CONTEXTUAL_ONLY",
      record: { verification: { method: "arxiv" } },
    });
  });
});

describe("official-domain classification", () => {
  it("grants VERIFIED_PRIMARY to allowlisted hosts with a primary type, offline", async () => {
    const { ctx, network } = context();
    const result = await verifyCandidate(
      {
        identifier: "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=4",
        title: "Ley 1581 de 2012",
        firstAuthor: "Congreso de la Republica",
        year: 2012,
        type: "law",
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: "VERIFIED_PRIMARY",
      record: { verification: { method: "official_domain" }, type: "law" },
    });
    expect(network.calls).toHaveLength(0);
  });

  it("denies lookalike hosts, indexing services, wrong types and unknown hosts", () => {
    const decide = (url: string, type: Parameters<typeof classifyHost>[1] = "law") =>
      classifyHost(url, type, domains).tier;
    expect(decide("https://secretariasenado.gov.co/x")).toBe("primary");
    expect(decide("http://secretariasenado.gov.co/x")).toBe("primary");
    expect(decide("https://gov.co.evil.example/x")).toBe("none");
    expect(decide("https://notgov.co/x")).toBe("none");
    expect(decide("https://evil.example/gov.co")).toBe("none");
    expect(decide("https://user:pw@sic.gov.co/x")).toBe("none");
    expect(decide("https://publindex.minciencias.gov.co/x")).toBe("indexing");
    expect(decide("https://www.scielo.org.co/x")).toBe("indexing");
    expect(decide("https://dane.gov.co/x", "web_page")).toBe("type_not_allowed");
    expect(decide("https://dane.gov.co/x", "journal_article")).toBe("type_not_allowed");
    expect(decide("https://www.icontec.org/x", "standard")).toBe("primary");
    expect(decide("https://www.icontec.org/x", "law")).toBe("type_not_allowed");
    expect(decide("https://example.edu.co/x")).toBe("none");
    expect(decide("not a url")).toBe("none");
  });

  it("leaves non-official URLs unverified", async () => {
    const { ctx } = context();
    expect(
      await verifyCandidate(
        {
          identifier: "https://blog.example.com/post",
          title: "A post",
          year: 2024,
          type: "report",
        },
        ctx,
      ),
    ).toMatchObject({ status: "UNVERIFIED", reason: "not_official_domain" });
    expect(
      await verifyCandidate(
        {
          identifier: "https://publindex.minciencias.gov.co/x",
          title: "A journal",
          year: 2024,
          type: "report",
        },
        ctx,
      ),
    ).toMatchObject({ reason: "indexing_only" });
    expect(
      await verifyCandidate(
        { identifier: "https://dane.gov.co/x", title: "A page", year: 2024, type: "web_page" },
        ctx,
      ),
    ).toMatchObject({ reason: "type_not_primary" });
  });

  it("reads the allowlist from the compliance profile", () => {
    const profile = {
      rules: [
        {
          kind: "official_domain_allowlist",
          values: {
            tier: "primary",
            hostSuffixes: ["gov.co"],
            explicitHosts: ["dane.gov.co"],
            allowedTypes: ["law"],
          },
        },
        {
          kind: "official_domain_allowlist",
          values: { tier: "indexing", explicitHosts: ["scielo.org.co"] },
        },
        { kind: "paper", values: {} },
      ],
    } as unknown as ComplianceProfile;
    expect(officialDomainsFromProfile(profile)).toEqual({
      primary: [{ hosts: ["gov.co", "dane.gov.co"], allowedTypes: ["law"] }],
      indexing: ["scielo.org.co"],
    });
    expect(officialDomainsFromProfile(undefined)).toEqual({ primary: [], indexing: [] });
  });
});

describe("auditor limits", () => {
  it("allows downgrades and refuses upgrades", () => {
    expect(applyAuditorStatus("VERIFIED_PEER_REVIEWED", "CONTEXTUAL_ONLY")).toBe("CONTEXTUAL_ONLY");
    expect(applyAuditorStatus("CONTEXTUAL_ONLY", "VERIFIED_PRIMARY")).toBe("CONTEXTUAL_ONLY");
    expect(applyAuditorStatus("VERIFIED_PEER_REVIEWED", undefined)).toBe("VERIFIED_PEER_REVIEWED");
    expect(applyAuditorStatus("VERIFIED_PEER_REVIEWED", "VERIFIED_PEER_REVIEWED")).toBe(
      "VERIFIED_PEER_REVIEWED",
    );
  });
});
