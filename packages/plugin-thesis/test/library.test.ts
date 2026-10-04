import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { escapeBibtex, generateBibtex } from "../src/research/bibtex.js";
import {
  addOrMerge,
  allocateCiteKey,
  appendRejected,
  appendSearchLog,
  evidenceId,
  nextEvidenceCounter,
  parseLibraryText,
  readLibrary,
  serializeLibrary,
  validateEvidenceRecord,
  writeLibrary,
} from "../src/research/library.js";
import type { RecordDraft } from "../src/research/verify.js";
import { type EvidenceRecord, idPatterns } from "../src/types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function base() {
  const dir = await mkdtemp(join(tmpdir(), "thesis-lib-"));
  dirs.push(dir);
  return dir;
}

const verification = {
  method: "crossref" as const,
  metadataMatch: 1,
  retracted: false,
  checkedAt: "2026-10-04T12:00:00.000Z",
};
const draft = (over: Partial<RecordDraft> = {}): RecordDraft => ({
  type: "journal_article",
  title: "Automated Verification of References",
  authors: [{ family: "Rojas", given: "Ana" }],
  year: 2021,
  doi: "10.5555/a.1",
  containerTitle: "Journal of Scholarly Tools",
  verification,
  status: "VERIFIED_PEER_REVIEWED",
  ...over,
});
const appraisal = {
  relevance: "medium" as const,
  evidenceType: "empirical",
  limitations: ["small sample"],
  supports: ["topic a"],
  permittedUse: ["background" as const],
};

describe("citation keys", () => {
  it("builds author-year keys that match the key pattern and disambiguate", () => {
    const taken = new Set<string>();
    const first = allocateCiteKey(draft(), taken);
    expect(first).toBe("rojas2021");
    taken.add(first);
    expect(allocateCiteKey(draft(), taken)).toBe("rojas2021b");
    taken.add("rojas2021b");
    expect(allocateCiteKey(draft(), taken)).toBe("rojas2021c");
    for (const key of [first, "rojas2021b"]) expect(key).toMatch(idPatterns.citationKey);
  });

  it("folds accents, strips punctuation and falls back to a title word or anon", () => {
    expect(allocateCiteKey(draft({ authors: [{ family: "García-Márquez" }] }), new Set())).toBe(
      "garciamarquez2021",
    );
    expect(allocateCiteKey(draft({ authors: [{ family: "O'Brien" }] }), new Set())).toBe(
      "obrien2021",
    );
    expect(allocateCiteKey(draft({ authors: [], title: "The Evidence Graph" }), new Set())).toBe(
      "evidence2021",
    );
    expect(allocateCiteKey(draft({ authors: [{ family: "Li" }] }), new Set())).toBe("li2021");
    expect(allocateCiteKey(draft({ authors: [{ family: "X" }], title: "" }), new Set())).toBe(
      "anon2021",
    );
    expect(allocateCiteKey(draft({ authors: [{ family: "A".repeat(60) }] }), new Set())).toMatch(
      idPatterns.citationKey,
    );
  });
});

describe("addOrMerge", () => {
  it("allocates ids from the counter and merges duplicates into the oldest id", () => {
    const records: EvidenceRecord[] = [];
    const counter = { value: 1 };
    const first = addOrMerge(records, draft(), appraisal, "SEC-01", counter);
    expect(first).toMatchObject({
      merged: false,
      record: { id: "EVD-00001", citeKey: "rojas2021", sections: ["SEC-01"] },
    });
    const sameDoi = addOrMerge(
      records,
      draft({ title: "Another title" }),
      { ...appraisal, relevance: "high", limitations: ["x"] },
      "SEC-02",
      counter,
    );
    expect(sameDoi.merged).toBe(true);
    expect(sameDoi.record.id).toBe("EVD-00001");
    expect(sameDoi.record.sections).toEqual(["SEC-01", "SEC-02"]);
    expect(sameDoi.record.appraisal).toMatchObject({
      relevance: "high",
      limitations: ["small sample", "x"],
    });
    const sameTitle = addOrMerge(
      records,
      draft({ doi: undefined, title: "AUTOMATED verification of references!" }),
      appraisal,
      "SEC-03",
      counter,
    );
    expect(sameTitle.merged).toBe(true);
    const other = addOrMerge(
      records,
      draft({ doi: "10.5555/b.2", title: "Something else", authors: [{ family: "Rojas" }] }),
      appraisal,
      "SEC-01",
      counter,
    );
    expect(other.record).toMatchObject({ id: "EVD-00002", citeKey: "rojas2021b" });
    expect(records).toHaveLength(2);
    expect(counter.value).toBe(3);
  });

  it("never reuses an id below the highest one in the library", () => {
    const records = [addOrMerge([], draft(), appraisal, "SEC-01", { value: 7 }).record];
    expect(nextEvidenceCounter(2, records)).toBe(8);
    expect(nextEvidenceCounter(20, records)).toBe(21);
    expect(evidenceId(231)).toBe("EVD-00231");
  });
});

describe("library files", () => {
  it("round-trips JSONL atomically with sorted keys and one record per line", async () => {
    const dir = await base();
    const records: EvidenceRecord[] = [];
    const counter = { value: 1 };
    addOrMerge(
      records,
      draft({ doi: "10.5555/b.2", title: "Second" }),
      appraisal,
      "SEC-01",
      counter,
    );
    addOrMerge(records, draft(), appraisal, "SEC-01", counter);
    await writeLibrary(dir, [...records].reverse());
    const text = await readFile(join(dir, "evidence", "library.jsonl"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe("EVD-00001");
    expect(lines[0]).toMatch(/^\{"appraisal":/);
    expect(await readLibrary(dir)).toEqual(records);
    expect((await stat(join(dir, "evidence", "library.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, "evidence"))).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(serializeLibrary(records)).toBe(text);
  });

  it("reports schema problems per line", () => {
    const bad = parseLibraryText('{"id":"EVD-1"}\nnot json\n');
    expect(bad.records).toEqual([]);
    expect(bad.errors.some((error) => error.line === 1)).toBe(true);
    expect(bad.errors.find((error) => error.line === 2)?.message).toMatch(/JSON/);
    expect(
      validateEvidenceRecord({
        ...addOrMerge([], draft(), appraisal, "SEC-01", { value: 1 }).record,
        extra: 1,
      }),
    ).toContain("unknown field extra");
  });

  it("appends the search log and de-duplicates rejected candidates", async () => {
    const dir = await base();
    const entry = {
      at: "2026-10-04T12:00:00.000Z",
      sectionId: "SEC-01",
      source: "openalex",
      query: "q",
      filters: { limit: 5 },
      hits: 2,
      selected: ["10.5555/a.1"],
    };
    await appendSearchLog(dir, [entry]);
    await appendSearchLog(dir, [{ ...entry, query: "q2" }]);
    const lines = (await readFile(join(dir, "evidence", "search-log.jsonl"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines.map((line) => JSON.parse(line).query)).toEqual(["q", "q2"]);
    const rejected = {
      at: entry.at,
      sectionId: "SEC-01",
      identifier: "10.5555/x.1",
      status: "UNVERIFIED" as const,
      reason: "doi_mismatch",
    };
    await appendRejected(dir, [rejected]);
    await appendRejected(dir, [
      rejected,
      { ...rejected, identifier: "10.5555/y.1", status: "UNVERIFIED" },
    ]);
    expect(
      (await readFile(join(dir, "evidence", "rejected.jsonl"), "utf8")).trimEnd().split("\n"),
    ).toHaveLength(2);
  });
});

describe("BibTeX", () => {
  const records = () => {
    const out: EvidenceRecord[] = [];
    const counter = { value: 1 };
    addOrMerge(
      out,
      draft({
        title: "Zeta & the 100% {Model}_x",
        authors: [{ family: "Zapata", given: "Ana" }, { family: "Ministerio de Salud" }],
        pages: "211-230",
        doi: "10.5555/z.1",
      }),
      appraisal,
      "SEC-01",
      counter,
    );
    addOrMerge(
      out,
      draft({
        type: "book",
        title: "Alpha",
        authors: [{ family: "Álvarez", given: "José" }],
        year: 2018,
        doi: undefined,
        containerTitle: undefined,
        publisher: "Press",
        isbn: "978-1-4028-9462-6",
      }),
      appraisal,
      "SEC-01",
      counter,
    );
    addOrMerge(
      out,
      draft({
        type: "law",
        title: "Ley 1581 de 2012",
        authors: [{ family: "Congreso de la República" }],
        year: 2012,
        doi: undefined,
        containerTitle: undefined,
        url: "https://www.funcionpublica.gov.co/x?i=1&b=2",
      }),
      appraisal,
      "SEC-01",
      counter,
    );
    return out;
  };

  it("is deterministic, sorted by key and independent of input order", () => {
    const first = generateBibtex(records());
    const second = generateBibtex([...records()].reverse());
    expect(first).toBe(second);
    const keys = [...first.matchAll(/^@\w+\{(\w+),/gm)].map((match) => match[1]);
    expect(keys).toEqual([...keys].sort());
    expect(first).not.toMatch(/\r/);
    expect(first.endsWith("}\n")).toBe(true);
  });

  it("escapes special characters and protects organizations", () => {
    const text = generateBibtex(records());
    expect(text).toContain("title = {{Zeta \\& the 100\\% \\{Model\\}\\_x}}");
    expect(text).toContain("author = {Zapata, Ana and {Ministerio de Salud}}");
    expect(text).toContain("pages = {211--230}");
    expect(text).toContain("author = {Álvarez, José}");
    expect(text).toContain("@book{alvarez2018,");
    expect(text).toContain("@misc{congresodelarepublica2012,");
    expect(text).toContain("type = {Law}");
    expect(escapeBibtex("a\\b ^ ~ $ #")).toBe("a\\textbackslash{}b \\^{} \\~{} \\$ \\#");
  });

  it("emits nothing for an empty library", () => {
    expect(generateBibtex([])).toBe("");
  });
});
