import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateBibtex } from "../src/research/bibtex.js";
import { parseLibraryText } from "../src/research/library.js";
import { json } from "./helpers/data.js";
import { cleanup, intakeAnswers, type Lifecycle, lifecycle } from "./helpers/harness.js";
import {
  appraise,
  candidate,
  candidateSet,
  dossier,
  sae,
  searchPlan,
  standardCandidates,
  topics,
  toSections,
} from "./helpers/research.js";
import { fixture, fixtureClient } from "./helpers/scholar.js";

afterEach(cleanup);

async function ready(options: Parameters<typeof lifecycle>[0] = {}) {
  const h = await lifecycle({
    ...options,
    answers: [...intakeAnswers, ...(options.answers ?? [])],
  });
  await toSections(h);
  h.setInteractive(options.interactive ?? true);
  return h;
}

/** Script the whole loop for one round. */
function scriptResearch(
  h: Lifecycle,
  candidates = standardCandidates(),
  gaps: Parameters<typeof dossier>[0] = [],
) {
  h.script("thesis-librarian", json(searchPlan()), json(candidateSet(candidates)));
  h.script("thesis-evidence-auditor", appraise());
  h.script("thesis-architect", dossier(gaps));
}

const lines = async (h: Lifecycle, path: string) =>
  (await h.read(path))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("/thesis:research (headless)", () => {
  it("runs search, verification, appraisal and dossier, and writes the evidence files", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    const message = await h.run("research", "SEC-07");

    expect(message).toContain(
      "Researched SEC-07 Marco teórico: 3 queries, 6 candidate(s), 4 verified, 2 not accepted (1 doi_mismatch, 1 retracted).",
    );
    expect(message).toContain("Library: 3 added, 1 merged");
    expect(message).toContain("/thesis:approve SEC-07");
    expect(message).toContain("/thesis:research SEC-07 -- add");

    const library = parseLibraryText(await h.read("evidence/library.jsonl"));
    expect(library.errors).toEqual([]);
    expect(library.records.map((record) => [record.id, record.citeKey, record.status])).toEqual([
      ["EVD-00001", "rojas2021", "VERIFIED_PEER_REVIEWED"],
      ["EVD-00002", "vega2018", "VERIFIED_AUTHORITATIVE_GREY"],
      ["EVD-00003", "petrov2022", "CONTEXTUAL_ONLY"],
    ]);
    expect(library.records[0]).toMatchObject({
      doi: "10.5555/sae.2021.014",
      sections: ["SEC-07"],
      appraisal: { relevance: "high" },
      verification: { method: "crossref", retracted: false },
    });
    expect((await h.state()).counters.evidence).toBe(3);

    const rejected = await lines(h, "evidence/rejected.jsonl");
    expect(rejected.map((entry) => [entry.identifier, entry.status, entry.reason])).toEqual([
      ["10.5555/soil.2015.099", "UNVERIFIED", "doi_mismatch"],
      ["10.5555/ret.2020.007", "REJECTED", "retracted"],
    ]);

    // The search log records every executed query with its hit count and the selected identifiers.
    const log = await lines(h, "evidence/search-log.jsonl");
    expect(log.map((entry) => [entry.source, entry.query, entry.hits])).toEqual([
      ["openalex", "verificación automática de referencias", 2],
      ["crossref", "citation integrity theses", 2],
      ["arxiv", "citation checking language models", 2],
    ]);
    expect(log[0]).toMatchObject({
      sectionId: "SEC-07",
      filters: { fromYear: 2015, toYear: 2026, language: "es", limit: 10 },
    });
    expect(log[0].selected).toEqual(["10.5555/sae.2021.014", "W1001"]);
    expect(log[2].selected).toEqual(["arXiv:2203.01234"]);
    expect(JSON.stringify(log)).not.toMatch(/mailto/);

    // references.bib is a pure function of the library.
    expect(await h.read("bibliography/references.bib")).toBe(generateBibtex(library.records));

    // Dossier markdown and sidecar.
    const dossierText = await h.read("evidence/dossiers/SEC-07.md");
    expect(dossierText).toContain("# SEC-07 Marco teórico: Dossier de investigación");
    expect(dossierText).toContain("[@rojas2021]");
    expect(dossierText).toContain("| EVD-00003 | petrov2022 | CONTEXTUAL_ONLY | no |");
    expect(dossierText).toContain("Queries: 3 (arxiv, crossref, openalex); failed: 0");
    expect(JSON.parse(await h.read("evidence/dossiers/SEC-07.json")).synthesis).toHaveLength(2);

    const state = await h.state();
    expect(state.sections["SEC-07"].status).toBe("research_review");
    expect(state.sections["SEC-07"].dossierAt).toBeDefined();
    expect(await h.run("check", "G2 G5")).toContain("Checks passed");
  });

  it("gives the librarian the scholar tools and the optional host web tools", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    const librarian = h.prompts.filter((entry) => entry.role === "thesis-librarian");
    expect(librarian).toHaveLength(2);
    const spec = librarian[0]?.spec as {
      tools: { allow: string[]; deny: string[] };
      timeoutMs: number;
      readOnly: boolean;
    };
    expect(spec.tools.allow).toEqual(
      expect.arrayContaining([
        "thesis_scholar_search",
        "thesis_scholar_resolve",
        "web_search",
        "web_fetch",
        "brave_web_search",
        "brave_llm_context",
      ]),
    );
    expect(spec.tools.allow).not.toContain("brave_*");
    expect(spec.tools.deny).toEqual(expect.arrayContaining(["task", "delegate"]));
    expect(spec).toMatchObject({ timeoutMs: 300_000, readOnly: true });
    const auditor = h.prompts.find((entry) => entry.role === "thesis-evidence-auditor")?.spec as {
      tools: { allow: string[] };
    };
    expect(auditor.tools.allow).toContain("thesis_scholar_resolve");
    // The auditor sees only verified candidates, never the mismatched or retracted ones.
    const auditPrompt = h.prompts.find((entry) => entry.role === "thesis-evidence-auditor")
      ?.prompt as string;
    expect(auditPrompt).not.toContain("soil.2015.099");
    expect(auditPrompt).not.toContain("ret.2020.007");
    expect(auditPrompt).toContain('"assignedStatus":"VERIFIED_PEER_REVIEWED"');
  });

  it("produces a byte-identical references.bib for the same library across runs", async () => {
    const first = await ready();
    first.setInteractive(false);
    scriptResearch(first);
    await first.run("research", "SEC-07");
    const second = await ready();
    second.setInteractive(false);
    scriptResearch(second, [...standardCandidates()].reverse());
    await second.run("research", "SEC-07");
    expect(await first.read("bibliography/references.bib")).toContain("@article{rojas2021,");
    const sortedKeys = (text: string) =>
      [...text.matchAll(/^@\w+\{(\w+),/gm)].map((match) => match[1]);
    expect(sortedKeys(await second.read("bibliography/references.bib"))).toEqual(
      sortedKeys(await first.read("bibliography/references.bib")),
    );
    // Same records in any order produce the same bytes.
    const records = parseLibraryText(await first.read("evidence/library.jsonl")).records;
    expect(generateBibtex([...records].reverse())).toBe(
      await first.read("bibliography/references.bib"),
    );
  });

  it("does not repeat queries already in the search log", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet([sae])));
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    const calls = h.network.calls.length;
    const message = await h.run("research", "SEC-07 -- integridad académica");
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian").at(-2)?.prompt).toContain(
      "integridad académica",
    );
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian").at(-2)?.prompt).toContain(
      "openalex: verificación automática de referencias",
    );
    expect(message).toContain("0 queries");
    expect(
      h.network.calls
        .slice(calls)
        .every((call) => !call.url.includes("/works?") && !call.url.includes("search_query")),
    ).toBe(true);
    expect((await lines(h, "evidence/search-log.jsonl")).length).toBe(3);
    expect((await lines(h, "evidence/library.jsonl")).length).toBe(3);
  });

  it("rejects an auditor that tries to upgrade a status, with one retry", async () => {
    const h = await ready();
    h.setInteractive(false);
    h.script(
      "thesis-librarian",
      json(searchPlan()),
      json(candidateSet([standardCandidates()[4] as never])),
    );
    h.script(
      "thesis-evidence-auditor",
      appraise({ status: "VERIFIED_PRIMARY" }),
      appraise({ status: "UNVERIFIED" }),
    );
    h.script("thesis-architect", dossier());
    const message = await h.run("research", "SEC-07");
    expect(
      h.prompts.find(
        (entry) => entry.role === "thesis-evidence-auditor" && entry.prompt.includes("rejected"),
      )?.prompt,
    ).toMatch(/would upgrade CONTEXTUAL_ONLY/);
    // The retry downgrades it, so it leaves the library for rejected.jsonl.
    expect(message).toContain("1 verified, 1 not accepted (1 auditor_downgrade)");
    expect(await h.read("evidence/library.jsonl")).toBe("");
    expect((await lines(h, "evidence/rejected.jsonl"))[0]).toMatchObject({
      reason: "auditor_downgrade",
    });
  });

  it("reports an invalid dossier and keeps the section where it was", async () => {
    const h = await ready();
    h.setInteractive(false);
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet([sae])));
    h.script("thesis-evidence-auditor", appraise());
    h.script(
      "thesis-architect",
      json({
        synthesis: [],
        claims: [{ text: "x", kind: "result", evidence: ["EVD-09999"] }],
        gaps: [],
      }),
      json({ synthesis: [], claims: [], gaps: [] }),
    );
    const message = await h.run("research", "SEC-07");
    expect(h.prompts.at(-1)?.prompt).toContain("unknown evidence id EVD-09999");
    expect(message).toMatch(
      /thesis-architect did not return a valid result.*keeps its previous status/s,
    );
    expect(message).toContain('does not cover the research topic "verificación de referencias"');
    expect((await h.state()).sections["SEC-07"].status).toBe("planned");
    // The verified record is kept and the queries stay logged.
    expect((await lines(h, "evidence/library.jsonl")).length).toBe(1);
    expect((await lines(h, "evidence/search-log.jsonl")).length).toBe(3);
  });

  it("fails open when a source is down and aborts only when every source is", async () => {
    const partial = fixtureClient([
      { match: "api.openalex.org/works?", status: 500 },
      {
        match: "api.crossref.org/works/10.5555/sae.2021.014",
        body: fixture("crossref-work-match.json"),
      },
      { match: "api.crossref.org/works?", body: fixture("crossref-search.json") },
      { match: "export.arxiv.org", body: fixture("arxiv-search.xml") },
    ]);
    const h = await ready({ scholar: partial.client });
    h.setInteractive(false);
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet([sae])));
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    const message = await h.run("research", "SEC-07");
    expect(message).toContain("Researched SEC-07");
    const log = await lines(h, "evidence/search-log.jsonl");
    expect(log[0]).toMatchObject({ source: "openalex", hits: 0, error: "source unavailable" });
    expect(await h.read("evidence/dossiers/SEC-07.md")).toContain("failed: 1");

    const down = fixtureClient([{ match: "", status: 500 }]);
    const g = await ready({ scholar: down.client });
    g.setInteractive(false);
    g.script("thesis-librarian", json(searchPlan()));
    await expect(g.run("research", "SEC-07")).rejects.toThrow(/Every scholarly source failed/);
    expect((await g.state()).sections["SEC-07"].status).toBe("planned");
    expect(
      (await lines(g, "evidence/search-log.jsonl")).every(
        (entry) => entry.error === "source unavailable",
      ),
    ).toBe(true);
  });

  it("verifies a source the user adds without asking the librarian", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h, [sae]);
    await h.run("research", "SEC-07");
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    const librarianCalls = h.prompts.filter((entry) => entry.role === "thesis-librarian").length;
    const message = await h.run("research", "SEC-07 -- add 10.5555/book.2018.001");
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian")).toHaveLength(
      librarianCalls,
    );
    expect(message).toContain("1 candidate(s), 1 verified");
    const records = parseLibraryText(await h.read("evidence/library.jsonl")).records;
    expect(records.map((record) => record.citeKey)).toEqual(["rojas2021", "vega2018"]);
    expect(records[1]?.verification.metadataMatch).toBe(1);
  });

  it("accepts an official URL offline and refuses one that is not on the allowlist", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h, [sae]);
    await h.run("research", "SEC-07");
    h.script("thesis-evidence-auditor", appraise({}, {}));
    h.script("thesis-architect", dossier());
    const before = h.network.calls.length;
    const law =
      "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981; Ley 1581 de 2012; 2012; law";
    await h.run("research", `SEC-07 -- add ${law}`);
    expect(h.network.calls.length).toBe(before);
    const records = parseLibraryText(await h.read("evidence/library.jsonl")).records;
    expect(records.find((record) => record.type === "law")).toMatchObject({
      status: "VERIFIED_PRIMARY",
      verification: { method: "official_domain" },
    });
    expect(await h.run("check", "G2")).toContain("Checks passed");

    // An unknown host is UNVERIFIED and leaves no record.
    h.script("thesis-architect", dossier());
    await h.run(
      "research",
      "SEC-07 -- add https://blog.example.com/post; A blog post; 2024; report",
    );
    expect((await lines(h, "evidence/rejected.jsonl")).at(-1)).toMatchObject({
      reason: "not_official_domain",
    });
    await expect(h.run("research", "SEC-07 -- add https://dane.gov.co/x")).rejects.toThrow(
      /needs its metadata/,
    );
  });
});

describe("research validation and approval", () => {
  it("asks Approve research (recommended), Search more and Add a source interactively", async () => {
    const h = await ready({ answers: [{ research: "approve" }] });
    scriptResearch(h);
    const message = await h.run("research", "SEC-07");
    const question = h.asked.at(-1)?.questions[0];
    expect(question?.id).toBe("research");
    expect(question?.options.map((option) => option.label)).toEqual([
      "Approve research",
      "Search more",
      "Add a source I have",
    ]);
    expect(question?.options.map((option) => option.recommended === true)).toEqual([
      true,
      false,
      false,
    ]);
    expect(question?.options.slice(1).every((option) => option.textInput !== undefined)).toBe(true);
    expect(message).toContain("Approved the research for SEC-07.");
    expect((await h.state()).sections["SEC-07"].status).toBe("research_approved");
  });

  it("recommends searching more when a gap is critical", async () => {
    const h = await ready({ answers: [{}] });
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet([sae])));
    h.script("thesis-evidence-auditor", appraise());
    h.script(
      "thesis-architect",
      dossier([{ topic: topics[1], description: "No source found", critical: true }]),
    );
    const message = await h.run("research", "SEC-07");
    const options = h.asked.at(-1)?.questions[0]?.options ?? [];
    expect(options.map((option) => option.recommended === true)).toEqual([false, true, false]);
    expect(message).toContain("Gaps: (critical) integridad de citas");
    expect(message).toContain("/thesis:approve SEC-07");
    expect((await h.state()).sections["SEC-07"].status).toBe("research_review");
  });

  it("searches more with the user's text, then approves", async () => {
    const h = await ready({
      answers: [
        { research: "more", "research:text": "integridad académica" },
        { research: "approve" },
      ],
    });
    scriptResearch(h);
    h.script(
      "thesis-librarian",
      json(
        searchPlan({
          queries: [
            {
              topic: topics[0],
              query: "academic integrity automation",
              source: "openalex",
              limit: 5,
            },
          ],
        }),
      ),
      json(candidateSet([standardCandidates()[3] as never])),
    );
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    const message = await h.run("research", "SEC-07");
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian")[2]?.prompt).toContain(
      "integridad académica",
    );
    expect(message).toContain("Approved the research for SEC-07.");
    expect((await lines(h, "evidence/library.jsonl")).length).toBe(3);
  });

  it("adds a user-supplied source from the interactive option", async () => {
    const h = await ready({
      answers: [
        { research: "add", "research:text": "10.5555/book.2018.001" },
        { research: "approve" },
      ],
    });
    scriptResearch(h, [sae]);
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    await h.run("research", "SEC-07");
    expect((await lines(h, "evidence/library.jsonl")).map((record) => record.citeKey)).toEqual([
      "rojas2021",
      "vega2018",
    ]);
  });

  it("stops after three interactive rounds", async () => {
    const more = { research: "more", "research:text": "again" };
    const h = await ready({ answers: [more, more, more] });
    for (let round = 0; round < 3; round += 1) {
      h.script(
        "thesis-librarian",
        json(
          searchPlan({
            queries: [{ topic: topics[0], query: `query ${round}`, source: "openalex", limit: 5 }],
          }),
        ),
        json(candidateSet([sae])),
      );
      h.script("thesis-evidence-auditor", appraise());
      h.script("thesis-architect", dossier());
    }
    expect(await h.run("research", "SEC-07")).toContain("Stopped after 3 rounds");
  });

  it("approves from the command line only after G2 passes, and warns below the evidence minimum", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    const message = await h.run("approve", "SEC-07");
    expect(message).toContain("Approved the research for SEC-07.");
    expect(message).toMatch(
      /Warning: EVD-010 evidence\/library\.jsonl: SEC-07 has 2 citable record\(s\); GLOBAL\.WORKTYPE\.EVIDENCE\.MASTER\.MASTER_THESIS suggests at least 30/,
    );
    expect(await h.run("approve", "SEC-07")).toContain("already approved");
    const check = await h.run("check", "G2");
    expect(check).toContain("EVD-010");
    expect(check).toContain("Checks passed");
  });

  it("blocks approval while G2 has errors", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    const path = join(h.workspace, "thesis", "evidence", "library.jsonl");
    const text = (await readFile(path, "utf8")).replace(
      /"status":"VERIFIED_PEER_REVIEWED"/,
      '"status":"VERIFIED_PRIMARY"',
    );
    await writeFile(path, text);
    expect(await h.run("approve", "SEC-07")).toMatch(/Blocked: G2 has errors[\s\S]*EVD-003/);
    expect((await h.state()).sections["SEC-07"].status).toBe("research_review");
  });

  it("records an explicit approval of CONTEXTUAL_ONLY evidence in the section state", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    expect(await h.run("approve", "SEC-07 -- contextual EVD-00001")).toMatch(
      /Blocked: name CONTEXTUAL_ONLY evidence.*Not eligible: EVD-00001/,
    );
    expect(await h.run("approve", "SEC-07 -- contextual EVD-00003")).toContain(
      "Recorded your explicit approval to cite EVD-00003",
    );
    expect((await h.state()).sections["SEC-07"].contextualApprovals).toEqual(["EVD-00003"]);
    expect(await h.run("check", "G2")).toContain("Checks passed");
  });

  it("revises a section's research through /thesis:revise with the feedback as the focus", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    h.script(
      "thesis-librarian",
      json(
        searchPlan({
          queries: [{ topic: topics[0], query: "another angle", source: "openalex", limit: 3 }],
        }),
      ),
      json(candidateSet([])),
    );
    h.script("thesis-architect", dossier());
    const message = await h.run("revise", "SEC-07 -- look for Latin American studies");
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian").at(-2)?.prompt).toContain(
      "look for Latin American studies",
    );
    expect(message).toContain("0 candidate(s)");
    expect(await h.read("evidence/dossiers/SEC-07.md")).toContain(
      "Focus of this round: look for Latin American studies",
    );
  });
});

describe("section order and /thesis:next", () => {
  it("respects dependsOn when picking and when targeting a section", async () => {
    const h = await ready();
    h.setInteractive(false);
    expect(await h.run("research", "SEC-08")).toMatch(/Blocked: SEC-08 depends on SEC-07/);
    expect(await h.run("status")).toContain("Next: /thesis:draft SEC-03");
    h.script("thesis-librarian", json(searchPlan()), json(candidateSet([sae])));
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier([], ["tema de Introducción"]));
    await h.run("research", "next");
    expect(h.prompts.find((entry) => entry.role === "thesis-librarian")?.prompt).toContain(
      '"id":"SEC-04"',
    );
    expect(await h.run("status")).toContain("Next: /thesis:approve SEC-04");
    expect(await h.run("next")).toContain("SEC-04 is in research review");
  });

  it("rejects bad targets", async () => {
    const h = await ready();
    await expect(h.run("research", "oops")).rejects.toThrow(/Usage: \/thesis:research/);
    expect(await h.run("research", "SEC-99")).toMatch(/not a section/);
    expect(await h.run("research", "SEC-08")).toMatch(/Blocked: SEC-08 depends on SEC-07/);
  });
});

describe("check integration", () => {
  it("lets thesis_check run G2 and G5 over the written files", async () => {
    const h = await ready();
    h.setInteractive(false);
    scriptResearch(h);
    await h.run("research", "SEC-07");
    const tool = h.tools.get("thesis_check");
    const run = async (gates: string[]) => {
      const result = await tool?.execute({ gates }, { workspace: h.workspace } as never);
      const content = (result?.content ?? []) as { text: string }[];
      return JSON.parse(content[0]?.text ?? "null");
    };
    const report = await run(["G2", "G5"]);
    expect(report.ok).toBe(true);
    await writeFile(join(h.workspace, "thesis", "bibliography", "references.bib"), "@misc{x,}\n");
    const failing = await run(["G5"]);
    expect(failing.findings.map((finding: { code: string }) => finding.code)).toEqual(["CIT-004"]);
    expect(failing.ok).toBe(false);
  });
});

describe("candidate hygiene", () => {
  it("retries once when a candidate carries an identifier that is not an identifier", async () => {
    const h = await ready();
    h.setInteractive(false);
    h.script(
      "thesis-librarian",
      json(searchPlan()),
      json(candidateSet([candidate({ identifier: "see the paper", title: "x", year: 2020 })])),
      json(candidateSet([sae])),
    );
    h.script("thesis-evidence-auditor", appraise());
    h.script("thesis-architect", dossier());
    await h.run("research", "SEC-07");
    expect(h.prompts.filter((entry) => entry.role === "thesis-librarian").at(-1)?.prompt).toContain(
      "candidates[0].identifier is not a DOI",
    );
  });
});
