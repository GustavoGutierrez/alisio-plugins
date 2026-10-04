import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyBriefDefaults } from "../src/brief.js";
import {
  ethicsQuestions,
  mapEthicsRequirements,
  validateEthicsAnswers,
} from "../src/policy/ethics.js";
import { crossValidate } from "../src/policy/packs.js";
import {
  type ComplianceProfile,
  type LoadedRule,
  loadOverrides,
  loadPacks,
  parseRule,
  resolve,
  selectPacks,
} from "../src/policy/resolver.js";
import { canonicalJson } from "../src/storage.js";

const packsRoot = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
const overridesDir = fileURLToPath(new URL("./fixtures/overrides/", import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function brief(overrides: Partial<Parameters<typeof applyBriefDefaults>[0]> = {}) {
  return applyBriefDefaults({
    language: "es-CO",
    workType: "master_thesis",
    year: 2026,
    institution: { country: "CO" },
    ...overrides,
  });
}

async function coPacks() {
  const { packs, problems } = await loadPacks(packsRoot, "shipped");
  expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
  return selectPacks(packs, brief()).active;
}

function rule(partial: Partial<LoadedRule> & { ruleId: string }): LoadedRule {
  return {
    level: "INSTITUTIONAL_RULE",
    status: "active",
    requirement: { kind: "citation_style", values: { id: "apa-7" } },
    source: { reference: "test" },
    verification: { lastChecked: "2026-10-04", basis: "official_text" },
    supersedes: [],
    origin: { tier: "institution", file: "policy/institution.yaml" },
    ...partial,
  };
}

describe("pack loading", () => {
  it("loads every pack in a root with one loader, recording rule origins", async () => {
    const { packs, problems } = await loadPacks(packsRoot, "shipped");
    expect(problems).toEqual([]);
    expect(packs.map((pack) => `${pack.id}:${pack.scope}:${pack.location}`)).toEqual([
      "CO:country:shipped",
      "global:global:shipped",
    ]);
    const co = packs.find((pack) => pack.id === "CO");
    const margins = co?.rules.find((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS");
    expect(margins?.origin).toEqual({
      tier: "pack",
      packId: "CO",
      scope: "country",
      location: "shipped",
      file: "countries/CO/standards/format.yaml",
    });
  });

  it("selects the country pack by the brief and leaves others inactive", async () => {
    const { packs } = await loadPacks(packsRoot, "shipped");
    expect(selectPacks(packs, brief()).active.map((pack) => pack.id)).toEqual(["CO", "global"]);
    const mx = selectPacks(packs, brief({ institution: { country: "MX" } }));
    expect(mx.active.map((pack) => pack.id)).toEqual(["global"]);
    expect(mx.inactive).toEqual([expect.objectContaining({ packId: "CO" })]);
    const explicit = selectPacks(packs, brief({ policy: { packs: ["CO"] } }));
    expect(explicit.active.map((pack) => pack.id)).toEqual(["CO", "global"]);
    expect(selectPacks(packs, brief({ policy: { packs: ["nope"] } })).problems[0]?.code).toBe(
      "PCK-001",
    );
  });

  it("loads any countries/<CC> directory and reports invalid manifests, rules and shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "thesis-packs-"));
    dirs.push(root);
    await mkdir(join(root, "countries", "MX"), { recursive: true });
    await mkdir(join(root, "countries", "BR"), { recursive: true });
    await writeFile(
      join(root, "countries", "MX", "manifest.yaml"),
      "packId: MX\nscope: country\nversion: '1'\nfiles: [missing.yaml]\n",
    );
    await writeFile(join(root, "countries", "BR", "manifest.yaml"), "id: BR\nkind: country\n");
    await writeFile(
      join(root, "countries", "MX", "a.yaml"),
      "ruleId: MX.NO.SOURCE\nlevel: LAW\nstatus: active\nrequirement: { kind: ethics_trigger }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n",
    );
    await writeFile(join(root, "countries", "MX", "domains.yaml"), "just: a list of words\n");
    await writeFile(join(root, "countries", "MX", "broken.yaml"), "a: [unclosed\n");
    await writeFile(
      join(root, "countries", "MX", "kind.yaml"),
      "rules:\n  - ruleId: MX.BAD.KIND\n    level: LAW\n    status: active\n    requirement: { kind: invented_kind }\n    source: { reference: r }\n    verification: { lastChecked: '2026-10-04', basis: official_text }\n",
    );
    const { packs, problems } = await loadPacks(root, "workspace");
    expect(packs.map((pack) => pack.id)).toEqual(["MX"]);
    const codes = problems.map((problem) => `${problem.code}:${problem.severity}:${problem.file}`);
    expect(codes).toContain("PCK-001:error:policy-packs/countries/MX/a.yaml");
    expect(codes).toContain("POL-003:warning:policy-packs/countries/MX/domains.yaml");
    expect(codes).toContain("PCK-001:error:policy-packs/countries/MX/broken.yaml");
    expect(codes).toContain("PCK-001:error:policy-packs/countries/MX/manifest.yaml");
    expect(codes).toContain("PCK-001:error:policy-packs/countries/BR/manifest.yaml");
    expect(problems.some((problem) => /closed vocabulary/.test(problem.message))).toBe(true);
    expect(problems.some((problem) => /missing\.yaml does not exist/.test(problem.message))).toBe(
      true,
    );
  });

  it("requires packId and scope in manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "thesis-packs-"));
    dirs.push(root);
    await mkdir(join(root, "global"), { recursive: true });
    await writeFile(join(root, "global", "manifest.yaml"), "kind: global\nversion: x\n");
    const { packs, problems } = await loadPacks(root, "shipped");
    expect(packs).toEqual([]);
    expect(problems.map((problem) => problem.message).join("\n")).toMatch(
      /packId is required[\s\S]*scope is required/,
    );
  });

  it("accepts a top-level rules list and a manifest with extra draft fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "thesis-packs-"));
    dirs.push(root);
    await mkdir(join(root, "global"), { recursive: true });
    await writeFile(
      join(root, "global", "manifest.yaml"),
      "packId: global\nscope: global\nversion: '1'\nkind: global\nlastChecked: '2026-10-04'\nrequirementKinds: [paper]\ndefaults: { citationStyle: apa-7 }\n",
    );
    await writeFile(
      join(root, "global", "r.yaml"),
      "rules:\n  - ruleId: G.OK.01\n    level: RECOMMENDATION\n    status: active\n    appliesWhen: {}\n    requirement: { kind: paper, values: { size: A4 } }\n    source: { reference: r }\n    verification: { lastChecked: '2026-10-04', basis: official_text }\n    supersedes: []\n",
    );
    const { packs, problems } = await loadPacks(root, "shipped");
    expect(problems).toEqual([]);
    expect(packs[0]?.rules).toHaveLength(1);
  });

  it("treats nested faculty and program folders as narrower scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "thesis-packs-"));
    dirs.push(root);
    const inst = join(root, "institutions", "CO", "example-university");
    await mkdir(join(inst, "faculties", "engineering", "programs", "systems"), { recursive: true });
    await writeFile(
      join(inst, "manifest.yaml"),
      "packId: CO-example-university\nscope: institution\nversion: '1'\nextends: CO\n",
    );
    const rule = (id: string) =>
      `ruleId: ${id}\nlevel: INSTITUTIONAL_RULE\nstatus: active\nrequirement: { kind: citation_style, values: { id: ieee } }\nsource: { reference: r }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n`;
    await writeFile(join(inst, "inst.yaml"), rule("EX.INST.01"));
    await writeFile(join(inst, "faculties", "engineering", "fac.yaml"), rule("EX.FAC.01"));
    await writeFile(
      join(inst, "faculties", "engineering", "programs", "systems", "prog.yaml"),
      rule("EX.PROG.01"),
    );
    const workspace = (await loadPacks(root, "workspace")).packs;
    const { packs: shipped } = await loadPacks(packsRoot, "shipped");
    const all = [...shipped, ...workspace];
    const named = (faculty: string, program: string) =>
      brief({ institution: { country: "CO", name: "Example University", faculty, program } });
    const ids = (b: ReturnType<typeof named>) =>
      selectPacks(all, b)
        .active.flatMap((pack) => pack.rules.map((entry) => entry.ruleId))
        .filter((id) => id.startsWith("EX."));
    expect(ids(named("Engineering", "Systems")).sort()).toEqual([
      "EX.FAC.01",
      "EX.INST.01",
      "EX.PROG.01",
    ]);
    expect(ids(named("Law", "Systems")).sort()).toEqual(["EX.INST.01"]);
    expect(
      selectPacks(all, brief({ institution: { country: "CO", name: "Another" } })).active.map(
        (pack) => pack.id,
      ),
    ).not.toContain("CO-example-university");
    const profile = resolve(
      named("Engineering", "Systems"),
      selectPacks(all, named("Engineering", "Systems")).active,
      [],
    );
    expect(profile.citationStyle.ruleIds.slice(0, 3)).toEqual([
      "EX.INST.01",
      "EX.FAC.01",
      "EX.PROG.01",
    ]);
  });

  it("rejects shadowing without overrides: true and accepts a deliberate override", async () => {
    const { packs: shipped } = await loadPacks(packsRoot, "shipped");
    const root = await mkdtemp(join(tmpdir(), "thesis-packs-"));
    dirs.push(root);
    const writeShadow = async (flag: string) => {
      const dir = join(root, "institutions", "CO", "example-university");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.yaml"),
        "packId: CO-example\nscope: institution\nversion: '1'\nextends: CO\n",
      );
      await writeFile(
        join(dir, "r.yaml"),
        `ruleId: TEST.CO.STANDARD.MARGINS\nlevel: INSTITUTIONAL_RULE\nstatus: active\n${flag}requirement: { kind: page_margins, values: { top: 2 } }\nsource: { reference: r }\nverification: { lastChecked: '2026-10-04', basis: official_text }\n`,
      );
      return (await loadPacks(root, "workspace")).packs;
    };
    const without = crossValidate([...shipped, ...(await writeShadow(""))]);
    expect(without).toEqual([
      expect.objectContaining({
        code: "PCK-002",
        severity: "error",
        file: expect.stringContaining("policy-packs/institutions/CO/example-university/r.yaml"),
      }),
    ]);
    const withFlag = [...shipped, ...(await writeShadow("overrides: true\n"))];
    expect(crossValidate(withFlag)).toEqual([]);
    const named = brief({
      citationStyle: "icontec-ntc1486-2022",
      institution: { country: "CO", name: "Example University" },
    });
    const profile = resolve(named, selectPacks(withFlag, named).active, []);
    expect(
      profile.rules.find((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS")?.values,
    ).toEqual({ top: 2 });
    expect(profile.overridden).toEqual([
      expect.objectContaining({
        ruleId: "TEST.CO.STANDARD.MARGINS",
        overriddenPack: "CO",
        by: "CO-example",
      }),
    ]);
  });

  it("flags unknown extends, duplicate packIds and a stray overrides flag", async () => {
    const { packs } = await loadPacks(packsRoot, "shipped");
    const co = packs.find((pack) => pack.id === "CO") as (typeof packs)[number];
    const dup = {
      ...co,
      location: "workspace" as const,
      dir: "countries/CO2",
      manifest: { ...co.manifest, extends: "ghost" },
    };
    const stray = {
      ...dup,
      id: "CO3",
      dir: "x/CO3",
      manifest: { ...co.manifest, packId: "CO3" },
      rules: [{ ...(co.rules[0] as LoadedRule), ruleId: "UNIQUE.RULE.01", overrides: true }],
    };
    const messages = crossValidate([...packs, dup, stray])
      .map((problem) => problem.message)
      .join("\n");
    expect(messages).toMatch(/packId CO is already used/);
    expect(messages).toMatch(/unknown pack ghost/);
    expect(messages).toMatch(/UNIQUE\.RULE\.01 sets overrides: true but no other rule/);
  });

  it("validates rule shape strictly", () => {
    const good = {
      ruleId: "X.Y.1",
      level: "LAW",
      status: "active",
      requirement: { kind: "ethics_trigger" },
      source: { reference: "r" },
      verification: { lastChecked: "2026-10-04", basis: "official_text" },
    };
    expect(parseRule(good, { tier: "pack", file: "f.yaml" }).errors).toEqual([]);
    const missing = (key: string) => {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      return parseRule(copy, { tier: "pack", file: "f.yaml" }).errors;
    };
    for (const key of ["ruleId", "level", "status", "requirement", "source", "verification"]) {
      expect(missing(key).length, key).toBeGreaterThan(0);
    }
    const badBasis = { ...good, verification: { lastChecked: "2026-10-04", basis: "rumour" } };
    expect(parseRule(badBasis, { tier: "pack", file: "f.yaml" }).errors.length).toBeGreaterThan(0);
    const noDate = { ...good, verification: { basis: "official_text" } };
    expect(parseRule(noDate, { tier: "pack", file: "f.yaml" }).errors.length).toBeGreaterThan(0);
    const badLevel = { ...good, level: "OPINION" };
    expect(parseRule(badLevel, { tier: "pack", file: "f.yaml" }).errors.length).toBeGreaterThan(0);
  });

  it("loads project overrides with a tier derived from the file name", async () => {
    const { rules, problems } = await loadOverrides(overridesDir);
    expect(problems).toEqual([]);
    const tiers = Object.fromEntries(rules.map((entry) => [entry.ruleId, entry.origin.tier]));
    expect(tiers["TEST.INST.CITATION"]).toBe("institution");
    expect(tiers["TEST.FAC.CITATION"]).toBe("faculty");
    expect(tiers["TEST.WRITING.PERSON"]).toBe("writing-guide");
    expect((await loadOverrides(join(overridesDir, "missing"))).rules).toEqual([]);
  });
});

describe("resolver precedence", () => {
  it("never auto-selects ICONTEC for Colombia without an institution rule", async () => {
    const profile = resolve(brief(), await coPacks(), []);
    expect(profile.citationStyle).toMatchObject({
      value: "apa-7",
      defaulted: true,
      source: "default",
    });
    expect(profile.citationStyle.ruleIds).toEqual(["TEST.GLOBAL.CITATION.DEFAULT"]);
    expect(profile.presentationStandard).toMatchObject({
      value: "apa-7",
      source: "derived",
      defaulted: true,
    });
    expect(profile.rules.some((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS")).toBe(false);
  });

  it("falls back to apa-7 and generic when nothing sets them", () => {
    const profile = resolve(brief(), [], []);
    expect(profile.citationStyle).toMatchObject({
      value: "apa-7",
      source: "default",
      defaulted: true,
    });
    expect(profile.citationStyle.ruleIds).toEqual([]);
    expect(profile.presentationStandard.value).toBe("apa-7");
  });

  it("uses the user's explicit round-2 choice over pack defaults", async () => {
    const profile = resolve(brief({ citationStyle: "icontec-ntc1486-2022" }), await coPacks(), []);
    expect(profile.citationStyle).toMatchObject({
      value: "icontec-ntc1486-2022",
      source: "brief",
      defaulted: false,
    });
    expect(profile.presentationStandard).toMatchObject({
      value: "icontec-ntc1486-2022",
      source: "derived",
    });
    expect(profile.rules.some((entry) => entry.ruleId === "TEST.CO.STANDARD.MARGINS")).toBe(true);
  });

  it("lets an institution rule decide auto and records the trail", async () => {
    const { rules } = await loadOverrides(overridesDir);
    const profile = resolve(brief(), await coPacks(), rules);
    expect(profile.citationStyle).toMatchObject({
      value: "icontec-ntc1486-2022",
      source: "rule",
      defaulted: false,
    });
    // institution first, then the faculty rule that it overrides, then the global default
    expect(profile.citationStyle.ruleIds.slice(0, 2)).toEqual([
      "TEST.INST.CITATION",
      "TEST.FAC.CITATION",
    ]);
    expect(profile.presentationStandard).toMatchObject({
      value: "icontec-ntc1486-2022",
      source: "rule",
      ruleIds: ["TEST.INST.PRESENTATION"],
    });
  });

  it("lets a higher-precedence rule win over an explicit brief value and says so", async () => {
    const { rules } = await loadOverrides(overridesDir);
    const profile = resolve(brief({ citationStyle: "ieee" }), await coPacks(), rules);
    expect(profile.citationStyle.value).toBe("icontec-ntc1486-2022");
    expect(profile.citationStyle.note).toMatch(/ieee/);
  });

  it("orders institution, faculty, program, rubric, template", () => {
    const make = (tier: LoadedRule["origin"]["tier"], id: string) =>
      rule({
        ruleId: `T.${tier}`,
        requirement: { kind: "citation_style", values: { id } },
        origin: { tier, file: `policy/${tier}.yaml` },
      });
    const ordered = [
      make("template", "t-style"),
      make("rubric", "r-style"),
      make("program", "p-style"),
      make("faculty", "f-style"),
      make("institution", "i-style"),
    ];
    const winner = (list: LoadedRule[]) => resolve(brief(), [], list).citationStyle;
    expect(winner(ordered).value).toBe("i-style");
    expect(winner(ordered.slice(0, 4)).value).toBe("f-style");
    expect(winner(ordered.slice(0, 3)).value).toBe("p-style");
    expect(winner(ordered.slice(0, 2)).value).toBe("r-style");
    expect(winner(ordered.slice(0, 1)).value).toBe("t-style");
  });

  it("lets a law outrank an institution rule", () => {
    const law = rule({
      ruleId: "T.LAW",
      level: "LAW",
      requirement: { kind: "citation_style", values: { id: "ieee" } },
      origin: { tier: "pack", packId: "CO", file: "countries/CO/law.yaml" },
    });
    const institution = rule({ ruleId: "T.INST" });
    expect(resolve(brief(), [], [institution, law]).citationStyle.value).toBe("ieee");
  });

  it("records same-rank conflicts and picks the smallest ruleId deterministically", () => {
    const a = rule({
      ruleId: "T.B",
      requirement: { kind: "citation_style", values: { id: "ieee" } },
    });
    const b = rule({
      ruleId: "T.A",
      requirement: { kind: "citation_style", values: { id: "apa-7" } },
    });
    const profile = resolve(brief(), [], [a, b]);
    expect(profile.citationStyle.value).toBe("apa-7");
    expect(profile.conflicts).toEqual([
      expect.objectContaining({ kind: "citation_style", ruleIds: ["T.A", "T.B"], chosen: "T.A" }),
    ]);
  });

  it("resolves exclusive kinds by precedence and lists the superseded rules", async () => {
    const { rules } = await loadOverrides(overridesDir);
    const profile = resolve(
      brief({ citationStyle: "icontec-ntc1486-2022" }),
      await coPacks(),
      rules,
    );
    const margins = profile.rules.filter((entry) => entry.kind === "page_margins");
    expect(margins.map((entry) => entry.ruleId)).toEqual(["TEST.INST.MARGINS"]);
    expect(profile.superseded).toContainEqual({
      ruleId: "TEST.CO.STANDARD.MARGINS",
      supersededBy: "TEST.INST.MARGINS",
      reason: "precedence",
    });
  });

  it("honours status and explicit supersedes", () => {
    const old = rule({
      ruleId: "T.OLD",
      requirement: { kind: "ethics_trigger", values: { trigger: "animals" } },
    });
    const fresh = rule({
      ruleId: "T.NEW",
      requirement: { kind: "ethics_trigger", values: { trigger: "animals" } },
      supersedes: ["T.OLD"],
    });
    const draft = rule({ ruleId: "T.DRAFT", status: "draft" });
    const profile = resolve(brief(), [], [old, fresh, draft]);
    expect(profile.rules.map((entry) => entry.ruleId)).toEqual(["T.NEW"]);
    expect(profile.superseded).toContainEqual({
      ruleId: "T.OLD",
      supersededBy: "T.NEW",
      reason: "supersedes",
    });
  });

  it("applies appliesWhen against country, domain, approach and resolved standards", async () => {
    const health = resolve(
      brief({ domain: { primary: "health_sciences", secondary: [] } }),
      await coPacks(),
      [],
    );
    expect(health.rules.some((entry) => entry.ruleId === "TEST.CO.HEALTH.RISK")).toBe(true);
    const other = resolve(
      brief({
        institution: { country: "MX" },
        domain: { primary: "health_sciences", secondary: [] },
      }),
      await coPacks(),
      [],
    );
    expect(other.rules.some((entry) => entry.ruleId === "TEST.CO.HEALTH.RISK")).toBe(false);
    const review = resolve(brief({ approach: "systematic_review" }), await coPacks(), []);
    expect(review.rules.some((entry) => entry.ruleId === "TEST.GLOBAL.REPORTING.PRISMA")).toBe(
      true,
    );
    expect(
      resolve(brief(), await coPacks(), []).rules.some(
        (entry) => entry.ruleId === "TEST.GLOBAL.REPORTING.PRISMA",
      ),
    ).toBe(false);
  });

  it("warns about unknown appliesWhen keys and never applies those rules", () => {
    const typo = rule({ ruleId: "T.TYPO", appliesWhen: { countri: "CO" } });
    const profile = resolve(brief(), [], [typo]);
    expect(profile.rules).toEqual([]);
    expect(profile.warnings.join("\n")).toMatch(/T\.TYPO/);
  });

  it("resolves the AI declaration from policy and the brief setting", async () => {
    const packs = await coPacks();
    expect(resolve(brief(), packs, []).aiDeclaration).toMatchObject({
      required: true,
      setting: "auto",
    });
    const never = resolve(brief({ aiUse: { assisted: true, declaration: "never" } }), packs, []);
    expect(never.aiDeclaration.required).toBe(true);
    expect(never.aiDeclaration.conflict).toMatch(/never/);
    const always = resolve(brief({ aiUse: { assisted: true, declaration: "always" } }), [], []);
    expect(always.aiDeclaration).toMatchObject({ required: true, setting: "always" });
    expect(resolve(brief(), [], []).aiDeclaration).toMatchObject({ required: false });
  });

  it("lists secondary-source rules for confirmation", async () => {
    const profile = resolve(brief({ citationStyle: "icontec-ntc1486-2022" }), await coPacks(), []);
    expect(profile.secondarySourceRuleIds).toContain("TEST.CO.STANDARD.MARGINS");
  });

  it("is deterministic and carries no timestamps or absolute paths", async () => {
    const { rules } = await loadOverrides(overridesDir);
    const packs = await coPacks();
    const first = canonicalJson(resolve(brief(), packs, rules));
    const second = canonicalJson(resolve(brief(), [...packs].reverse(), [...rules].reverse()));
    expect(second).toBe(first);
    expect(first).not.toContain(packsRoot);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it("flags rules without source or verification date", () => {
    const profile: ComplianceProfile = resolve(brief(), [], [rule({ ruleId: "T.OK" })]);
    expect(profile.rules[0]?.verification.lastChecked).toBe("2026-10-04");
    expect(profile.rules[0]?.source.reference).toBe("test");
  });
});

describe("ethics questionnaire", () => {
  it("defines the eleven trigger questions including minors", () => {
    expect(ethicsQuestions.map((question) => question.id)).toEqual([
      "human_participants",
      "minors",
      "identifiable_personal_data",
      "sensitive_data",
      "intervention",
      "risk_above_minimal",
      "biological_samples",
      "animals",
      "communities",
      "clinical_research",
      "additional_institutional_rules",
    ]);
  });

  it("validates answers as booleans over known ids", () => {
    expect(validateEthicsAnswers({ identifiable_personal_data: true, animals: false })).toEqual({
      answers: { identifiable_personal_data: true, animals: false },
      errors: [],
    });
    const bad = validateEthicsAnswers({ personal_data: "yes", nope: true });
    expect(bad.errors.length).toBe(2);
  });

  it("maps yes answers to requirements from the resolved profile", async () => {
    const profile = resolve(
      brief({ domain: { primary: "health_sciences", secondary: [] } }),
      await coPacks(),
      [],
    );
    const mapped = mapEthicsRequirements(
      {
        human_participants: true,
        identifiable_personal_data: true,
        risk_above_minimal: true,
        animals: false,
      },
      profile,
    );
    expect(mapped.requirements.map((entry) => entry.id)).toEqual([
      "ETH-HUMAN_PARTICIPANTS-01",
      "ETH-IDENTIFIABLE_PERSONAL_DATA-01",
      "ETH-RISK_ABOVE_MINIMAL-01",
    ]);
    expect(
      mapped.requirements.find((entry) => entry.trigger === "identifiable_personal_data")?.ruleId,
    ).toBe("TEST.CO.PRIVACY.PERSONAL");
    expect(mapped.unmapped).toEqual([]);
    expect(mapped.unanswered).toContain("sensitive_data");
    expect(
      mapped.requirements.every((entry) => !/not required|unnecessary(?! )/.test(entry.text)),
    ).toBe(true);
  });

  it("adds a generic confirmation requirement for yes answers no rule covers", () => {
    const mapped = mapEthicsRequirements({ animals: true }, resolve(brief(), [], []));
    expect(mapped.unmapped).toEqual(["animals"]);
    expect(mapped.requirements).toEqual([
      expect.objectContaining({
        id: "ETH-ANIMALS-00",
        ruleId: null,
        generic: true,
        text: expect.stringContaining("Never assume consent is unnecessary"),
      }),
    ]);
  });
});
