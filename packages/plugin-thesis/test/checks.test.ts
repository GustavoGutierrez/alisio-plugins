import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, loadProject, parseGates, runChecks } from "../src/checks/index.js";
import { canonicalJson } from "../src/storage.js";

const packsRoot = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const validBrief = `schemaVersion: 1
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

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "thesis-checks-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function report(files: Record<string, string>, gates?: string[]) {
  const root = await workspace(files);
  const project = await loadProject(root, { packsRoot });
  return { root, project, report: runChecks(project, gates ? { gates: parseGates(gates) } : {}) };
}

const codes = (r: { findings: { code: string; severity: string }[] }, severity?: string) =>
  r.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);

describe("G0 brief checks", () => {
  it("passes a valid brief with no errors", async () => {
    const { report: result } = await report({ "thesis.yaml": validBrief });
    expect(codes(result, "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails when thesis.yaml is missing", async () => {
    const { report: result } = await report({ "other.txt": "x" });
    expect(codes(result, "error")).toEqual(["BRF-001"]);
    expect(result.ok).toBe(false);
  });

  it("fails on a broken brief with line numbers", async () => {
    const { report: result } = await report({
      "thesis.yaml": `${validBrief.replace("es-CO", "spanish")}typo: 1\n`,
    });
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors.map((f) => f.code).sort()).toEqual(["BRF-002", "BRF-003"]);
    expect(errors.every((f) => f.file === "thesis.yaml" && typeof f.line === "number")).toBe(true);
  });

  it("resolves workspace style ids discovered under styles/", async () => {
    const unknown = `${validBrief.replace("citationStyle: apa-7", "citationStyle: my-school")}`;
    expect(codes((await report({ "thesis.yaml": unknown })).report, "error")).toContain("BRF-004");
    const found = await report({ "thesis.yaml": unknown, "styles/my-school.csl": "<style/>" });
    expect(codes(found.report, "error")).not.toContain("BRF-004");
  });
});

describe("G0 policy checks", () => {
  it("warns when the profile file is missing or stale and accepts a fresh one", async () => {
    const first = await report({ "thesis.yaml": validBrief });
    expect(codes(first.report)).toContain("POL-002");
    const fresh = canonicalJson(first.project.profile);
    expect(
      codes((await report({ "thesis.yaml": validBrief, "compliance-profile.json": fresh })).report),
    ).not.toContain("POL-002");
    const stale = await report({
      "thesis.yaml": validBrief,
      "compliance-profile.json": `${fresh} `,
    });
    expect(codes(stale.report, "warning")).toContain("POL-002");
  });

  it("reports invalid project rules as POL-001 errors", async () => {
    const { report: result } = await report({
      "thesis.yaml": validBrief,
      "policy/institution.yaml": "- ruleId: INST.BAD.01\n  level: LAW\n",
    });
    expect(codes(result, "error")).toEqual(expect.arrayContaining(["PCK-001", "POL-001"]));
  });

  it("warns about a missing country pack and about defaulted styles", async () => {
    const auto = validBrief
      .replace("citationStyle: apa-7\n", "")
      .replace("presentation: { standard: apa-7 }\n", "")
      .replace("country: CO", "country: MX");
    const result = (await report({ "thesis.yaml": auto })).report;
    expect(codes(result, "warning")).toEqual(expect.arrayContaining(["POL-003", "POL-005"]));
    expect(result.ok).toBe(true);
  });

  it("lists secondary-source rules as info", async () => {
    const icontec = validBrief
      .replace("citationStyle: apa-7", "citationStyle: icontec-ntc1486-2022")
      .replace("standard: apa-7", "standard: icontec-ntc1486-2022");
    const result = (await report({ "thesis.yaml": icontec })).report;
    expect(codes(result, "info")).toContain("POL-006");
  });

  it("skips policy checks that need a brief when the brief is invalid", async () => {
    const result = (await report({ "thesis.yaml": "language: [bad\n" })).report;
    expect(codes(result).filter((code) => code.startsWith("POL-") && code !== "POL-003")).toEqual(
      [],
    );
  });
});

describe("workspace policy packs (PCK-*)", () => {
  const manifest =
    "packId: CO-example\nscope: institution\nversion: '1'\nextends: CO\nappliesWhen: { country: CO }\n";
  const rule = (extra = "") =>
    `ruleId: TEST.CO.STANDARD.MARGINS\nlevel: INSTITUTIONAL_RULE\nstatus: active\n${extra}requirement: { kind: page_margins, values: { top: 2 } }\nsource: { reference: Regulation 1 }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n`;
  const icontec = validBrief
    .replace("citationStyle: apa-7", "citationStyle: icontec-ntc1486-2022")
    .replace("standard: apa-7", "standard: icontec-ntc1486-2022")
    .replace("name: Example University", "name: Example University");
  const dir = "policy-packs/institutions/CO/example-university";

  it("resolves a complete Colombian profile from shipped packs alone", async () => {
    const { project, report: result } = await report({ "thesis.yaml": icontec });
    expect(codes(result, "error")).toEqual([]);
    const profile = project.profile;
    expect(profile?.packs.map((pack) => pack.id)).toEqual(["global", "CO"]);
    expect(profile?.rules.some((entry) => entry.ruleId === "TEST.CO.PRIVACY.PERSONAL")).toBe(true);
    expect(profile?.rules.some((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS")).toBe(true);
  });

  it("applies a workspace institution pack that overrides a shipped rule with overrides: true", async () => {
    const { project, report: result } = await report({
      "thesis.yaml": icontec,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/rules.yaml`]: rule("overrides: true\n"),
    });
    expect(codes(result, "error")).toEqual([]);
    expect(
      project.profile?.rules.find((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS")?.values,
    ).toEqual({ top: 2 });
    expect(project.profile?.overridden).toHaveLength(1);
    expect(project.profile?.packs.map((pack) => pack.id)).toContain("CO-example");
  });

  it("fails PCK-002 when the override flag is missing", async () => {
    const { report: result } = await report({
      "thesis.yaml": icontec,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/rules.yaml`]: rule(),
    });
    const errors = result.findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["PCK-002", "POL-001"]),
    );
    expect(result.ok).toBe(false);
  });

  it("fails PCK-003 when equal-precedence workspace rules disagree", async () => {
    const two = (id: string, top: number) =>
      `ruleId: ${id}\nlevel: INSTITUTIONAL_RULE\nstatus: active\nrequirement: { kind: page_margins, values: { top: ${top} } }\nsource: { reference: r }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n`;
    const { report: result } = await report({
      "thesis.yaml": icontec,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/a.yaml`]: two("EX.A.01", 2),
      [`${dir}/b.yaml`]: two("EX.B.01", 3),
    });
    const finding = result.findings.find((entry) => entry.code === "PCK-003");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("a.yaml");
    expect(finding?.message).toContain("b.yaml");
  });

  it("warns PCK-004 for stale secondary sources and informs PCK-010 about extension kinds", async () => {
    const old = rule()
      .replace("official_text", "secondary_source")
      .replace("2026-10-04", "2024-01-01")
      .replace("TEST.CO.STANDARD.MARGINS", "EX.OLD.01")
      .replace("page_margins", "x-custom-thing");
    const { report: result } = await report({
      "thesis.yaml": icontec,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/rules.yaml`]: old,
    });
    expect(codes(result, "warning")).toContain("PCK-004");
    expect(codes(result, "info")).toContain("PCK-010");
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown requirement kind that is not an x- extension", async () => {
    const { report: result } = await report({
      "thesis.yaml": icontec,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/rules.yaml`]: rule()
        .replace("page_margins", "page_margin")
        .replace("TEST.CO.STANDARD.MARGINS", "EX.KIND.01"),
    });
    expect(result.findings.find((entry) => entry.code === "PCK-001")?.message).toMatch(
      /closed vocabulary/,
    );
  });

  it("keeps an institution pack inactive for another institution", async () => {
    const other = icontec.replace("Example University", "Another University");
    const { project } = await report({
      "thesis.yaml": other,
      [`${dir}/manifest.yaml`]: manifest,
      [`${dir}/rules.yaml`]: rule("overrides: true\n"),
    });
    expect(
      project.selection?.inactive.find((entry) => entry.packId === "CO-example")?.reason,
    ).toMatch(/institution/);
  });
});

describe("G7 hygiene (path leaks)", () => {
  const leaked = ["", "home", "someone", "thesis", "x.csv"].join("/");
  const winLeak = ["C:", "Users", "someone", "doc.docx"].join("\\");

  it("flags absolute local paths in chapters and the brief with file and line", async () => {
    const { report: result } = await report({
      "thesis.yaml": `${validBrief}# data at ${leaked}\n`,
      "chapters/01-intro.md": `Intro.\n\nSee ${winLeak} for details.\n`,
    });
    const hyg = result.findings.filter((f) => f.code === "HYG-001");
    expect(hyg.map((f) => `${f.file}:${f.line}`).sort()).toEqual([
      "chapters/01-intro.md:3",
      `thesis.yaml:${validBrief.split("\n").length}`,
    ]);
    expect(hyg.every((f) => f.severity === "error" && f.gate === "G7")).toBe(true);
  });

  it("does not flag URLs, relative paths or prose", async () => {
    const { report: result } = await report({
      "thesis.yaml": validBrief,
      "chapters/01-intro.md":
        "Visit https://example.org/home/page and figures/charts/home.vl.json. /etc is not flagged.\n",
    });
    expect(codes(result)).not.toContain("HYG-001");
  });
});

describe("runner and report", () => {
  it("filters by gate and sorts findings deterministically", async () => {
    const files = { "thesis.yaml": `${validBrief}typo: 1\n` };
    const g7 = (await report(files, ["G7"])).report;
    expect(g7.findings).toEqual([]);
    const all = (await report(files)).report;
    expect(all.findings.map((f) => f.gate)).toEqual(
      [...all.findings.map((f) => f.gate)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );
    expect(all.counts.error).toBe(1);
  });

  it("rejects unknown gates", () => {
    expect(() => parseGates(["G99"])).toThrow(/Unknown gate/);
    expect(parseGates(["g0", "G7", "G0"])).toEqual(["G0", "G7"]);
  });

  it("formats a readable report", async () => {
    const { report: result } = await report({ "thesis.yaml": `${validBrief}typo: 1\n` });
    const text = formatReport(result);
    expect(text).toContain("Checks failed");
    expect(text).toMatch(/ERROR BRF-002 \[G0\] thesis.yaml:\d+/);
  });

  it("uses the injected clock", async () => {
    const root = await workspace({ "thesis.yaml": validBrief });
    const project = await loadProject(root, { packsRoot });
    const at = runChecks(project, { now: () => new Date("2026-01-02T03:04:05.000Z") }).at;
    expect(at).toBe("2026-01-02T03:04:05.000Z");
    expect(await readFile(join(root, "thesis.yaml"), "utf8")).toBe(validBrief);
  });
});
