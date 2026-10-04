import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import { main } from "../src/cli.js";
import { buildOutline } from "../src/outline.js";
import { generateBibtex } from "../src/research/bibtex.js";
import { addOrMerge, serializeLibrary } from "../src/research/library.js";
import type { RecordDraft } from "../src/research/verify.js";
import { canonicalJson, defaultState, writeState } from "../src/storage.js";
import type { EvidenceRecord } from "../src/types.js";
import { outlineDraft } from "./helpers/data.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const brief = `schemaVersion: 1
language: es-CO
workType: master_thesis
title: Sample thesis
authors: [{ name: Ada Example }]
advisors: [{ name: Bo Example }]
institution: { name: Example University, country: CO }
year: 2026
citationStyle: apa-7
presentation: { standard: apa-7 }
`;

const verification = {
  method: "crossref" as const,
  metadataMatch: 1,
  retracted: false,
  checkedAt: "2026-10-04T12:00:00.000Z",
};
const draft = (over: Partial<RecordDraft> = {}): RecordDraft => ({
  type: "journal_article",
  title: "Automated Verification of References",
  authors: [{ family: "Rojas" }],
  year: 2021,
  doi: "10.5555/a.1",
  verification,
  status: "VERIFIED_PEER_REVIEWED",
  ...over,
});
const appraisal = {
  relevance: "high" as const,
  evidenceType: "empirical",
  limitations: ["x"],
  supports: [],
  permittedUse: ["background" as const],
};
const record = (over: Partial<RecordDraft> = {}, id = 1): EvidenceRecord =>
  addOrMerge([], draft(over), appraisal, "SEC-07", { value: id }).record;

async function files(map: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "thesis-evd-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(map)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
const withLibrary = (records: EvidenceRecord[], extra: Record<string, string> = {}) => ({
  "thesis.yaml": brief,
  "evidence/library.jsonl": serializeLibrary(records),
  "bibliography/references.bib": generateBibtex(records),
  ...extra,
});
async function codes(
  map: Record<string, string>,
  gates: string[],
  sections?: Record<string, { status: never }>,
) {
  const project = await loadProject(await files(map), sections ? { sections } : {});
  return runChecks(project, { gates: gates as never }).findings;
}

describe("EVD checks (G2)", () => {
  it("passes a consistent library", async () => {
    expect(await codes(withLibrary([record()]), ["G2", "G5"])).toEqual([]);
  });

  it("reports nothing before a library exists", async () => {
    expect(await codes({ "thesis.yaml": brief }, ["G2", "G5"])).toEqual([]);
  });

  it("EVD-001: schema, duplicate ids and keys", async () => {
    const a = record();
    const findings = await codes(
      {
        "thesis.yaml": brief,
        "evidence/library.jsonl": `${JSON.stringify({ ...a, extra: true })}\nnot json\n${JSON.stringify(a)}\n${JSON.stringify(a)}\n`,
      },
      ["G2"],
    );
    const messages = findings
      .filter((finding) => finding.code === "EVD-001")
      .map((finding) => finding.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "unknown field extra",
        "line is not valid JSON",
        "Evidence id EVD-00001 appears 2 times",
        "Citation key rojas2021 appears 2 times",
      ]),
    );
    expect(findings.find((finding) => finding.message === "line is not valid JSON")?.line).toBe(2);
  });

  it("EVD-002: duplicate DOI", async () => {
    const a = record();
    const b = { ...record({ title: "Other" }, 2), doi: "10.5555/A.1", citeKey: "rojas2021b" };
    const findings = await codes(withLibrary([a, b]), ["G2"]);
    expect(findings.map((finding) => finding.code)).toContain("EVD-002");
  });

  it("EVD-003: citable statuses must follow the verification rules", async () => {
    const weak = { ...record(), verification: { ...verification, metadataMatch: 0.5 } };
    const book = {
      ...record({ type: "book", doi: "10.5555/b.1", title: "A book" }, 2),
      status: "VERIFIED_PEER_REVIEWED" as const,
    };
    const primary = {
      ...record({ type: "law", doi: undefined, title: "Ley", url: "https://example.org/ley" }, 3),
      status: "VERIFIED_PRIMARY" as const,
      verification: { ...verification, method: "official_domain" as const },
    };
    const official = {
      ...record(
        {
          type: "law",
          doi: undefined,
          title: "Ley real",
          url: "https://www.funcionpublica.gov.co/x",
        },
        4,
      ),
      status: "VERIFIED_PRIMARY" as const,
      verification: { ...verification, method: "official_domain" as const },
    };
    const arxiv = {
      ...record({ doi: "10.5555/c.1", title: "Preprint" }, 5),
      status: "VERIFIED_PEER_REVIEWED" as const,
      verification: { ...verification, method: "arxiv" as const },
    };
    const findings = (
      await codes(withLibrary([weak, book, primary, official, arxiv]), ["G2"])
    ).filter((finding) => finding.code === "EVD-003");
    expect(findings.map((finding) => finding.message.split(" ")[0])).toEqual([
      "EVD-00001",
      "EVD-00002",
      "EVD-00003",
      "EVD-00005",
    ]);
    expect(findings[1]?.message).toMatch(/journal article or conference paper/);
    expect(findings[2]?.message).toMatch(/official domain/);
  });

  it("EVD-004: a retracted record cannot stay citable", async () => {
    const retracted = { ...record(), verification: { ...verification, retracted: true } };
    expect(
      (await codes(withLibrary([retracted]), ["G2"])).map((finding) => finding.code),
    ).toContain("EVD-004");
    const rejected = { ...retracted, status: "REJECTED" as const };
    expect(await codes(withLibrary([rejected]), ["G2"])).toEqual([]);
  });

  it("EVD-005: contextual approvals must name library records", async () => {
    const findings = await codes(withLibrary([record()]), ["G2"], {
      "SEC-07": { status: "research_review", contextualApprovals: ["EVD-00099"] } as never,
    });
    expect(findings.map((finding) => finding.code)).toEqual(["EVD-005"]);
  });

  it("EVD-010: warns when the theoretical framework has fewer citable records than the work type suggests", async () => {
    const outline = canonicalJson(
      buildOutline(outlineDraft(), { language: "es-CO", now: new Date("2026-10-04T12:00:00Z") }),
    );
    const map = withLibrary([record()], { "outline/outline.json": outline });
    const sections = {
      "SEC-07": { status: "research_approved" } as never,
      "SEC-08": { status: "research_approved" } as never,
    };
    const findings = (await codes(map, ["G2"], sections)).filter(
      (finding) => finding.code === "EVD-010",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning" });
    expect(findings[0]?.message).toMatch(
      /^SEC-07 has 1 citable record\(s\); .* suggests at least 30/,
    );
    // Not yet approved research, or an unknown progress, raises nothing.
    expect(
      (await codes(map, ["G2"], { "SEC-07": { status: "research_review" } as never })).filter(
        (finding) => finding.code === "EVD-010",
      ),
    ).toEqual([]);
    expect((await codes(map, ["G2"])).filter((finding) => finding.code === "EVD-010")).toEqual([]);
    // CONTEXTUAL_ONLY counts only after the user's approval.
    const contextual = {
      ...record({ doi: "10.5555/p.1", title: "Preprint" }, 2),
      status: "CONTEXTUAL_ONLY" as const,
      verification: { ...verification, method: "arxiv" as const },
    };
    const two = withLibrary([record(), contextual], { "outline/outline.json": outline });
    const approved = {
      "SEC-07": { status: "research_approved", contextualApprovals: ["EVD-00002"] } as never,
    };
    expect(
      (await codes(two, ["G2"], approved)).find((finding) => finding.code === "EVD-010")?.message,
    ).toContain("has 2 citable");
  });
});

describe("CIT-004 (G5)", () => {
  it("passes when references.bib is a fresh generation", async () => {
    expect(await codes(withLibrary([record()]), ["G5"])).toEqual([]);
  });

  it("fails when references.bib was edited or is missing", async () => {
    const edited = await codes(
      withLibrary([record()], { "bibliography/references.bib": "@misc{hand,}\n" }),
      ["G5"],
    );
    expect(edited.map((finding) => finding.code)).toEqual(["CIT-004"]);
    expect(edited[0]).toMatchObject({
      severity: "error",
      gate: "G5",
      file: "bibliography/references.bib",
    });
    const missing = await codes(
      { "thesis.yaml": brief, "evidence/library.jsonl": serializeLibrary([record()]) },
      ["G5"],
    );
    expect(missing.map((finding) => finding.code)).toEqual(["CIT-004"]);
  });

  it("does not guess when the library itself is invalid", async () => {
    const findings = await codes(
      {
        "thesis.yaml": brief,
        "evidence/library.jsonl": "garbage\n",
        "bibliography/references.bib": "x",
      },
      ["G5"],
    );
    expect(findings).toEqual([]);
  });
});

describe("alisio-thesis check CLI", () => {
  it("runs the evidence checks and exits 1 on CIT-004", async () => {
    const workspace = await files({
      "thesis/thesis.yaml": brief,
      "thesis/evidence/library.jsonl": serializeLibrary([record()]),
      "thesis/bibliography/references.bib": "stale\n",
    });
    const state = defaultState("thesis");
    await writeState(workspace, state);
    let out = "";
    const code = await main(["check", "--gate", "G5", "--no-write"], {
      cwd: workspace,
      stdout: (text) => (out += text),
      stderr: () => undefined,
    });
    expect(code).toBe(1);
    expect(out).toContain("CIT-004");
    const ok = await main(["check", "--gate", "G2", "--no-write"], {
      cwd: workspace,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(ok).toBe(0);
  });
});
