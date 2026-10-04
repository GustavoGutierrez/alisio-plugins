// biome-ignore-all lint/style/noNonNullAssertion: fixtures index arrays whose length the test controls
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import { outlineFindings, requiredSections } from "../src/checks/outline.js";
import {
  buildOutline,
  flattenOutline,
  parseOutline,
  renderOutlineMarkdown,
} from "../src/outline.js";
import { buildProtocol, parseProtocol, renderProtocol } from "../src/protocol.js";
import { type ProtocolDraft, validateOutlineDraft, validateProtocolDraft } from "../src/schemas.js";
import { canonicalJson } from "../src/storage.js";
import { outlineDraft, protocolDraft } from "./helpers/data.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const brief = (extra = "") => `schemaVersion: 1
language: es-CO
workType: master_thesis
title: Sample thesis
authors: [{ name: Ada Example }]
advisors: [{ name: Bo Example }]
institution: { name: Example University, country: CO }
year: 2026
citationStyle: apa-7
presentation: { standard: apa-7 }
approach: design_science
${extra}`;

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "thesis-design-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return loadProject(root);
}
const codes = (findings: { code: string; severity: string }[], severity?: string) =>
  findings
    .filter((finding) => !severity || finding.severity === severity)
    .map((finding) => finding.code);

const protocolText = (over: Record<string, unknown> = {}, language = "es-CO") => {
  const draft = validateProtocolDraft(protocolDraft(over), { approach: "design_science" })
    .value as ProtocolDraft;
  return renderProtocol(
    buildProtocol(draft, {
      language,
      now: new Date("2026-10-04T12:00:00Z"),
      revision: 1,
      ethicsRequirements: [],
    }),
  );
};

describe("ProtocolDraft", () => {
  const validate = (
    over: Record<string, unknown>,
    approach: "design_science" | "quantitative" = "design_science",
  ) => validateProtocolDraft(protocolDraft(over), { approach });

  it("accepts a complete draft and strips control characters", () => {
    expect(validate({}).errors).toEqual([]);
    const cleaned = validate({ problem: "Texto\u0001 con control" }).value;
    expect(cleaned?.problem).toBe("Texto con control");
  });

  it("rejects unknown fields, too few objectives and multi-word verbs", () => {
    expect(validate({ extra: 1 }).errors).toContain("ProtocolDraft: unknown field extra");
    expect(
      validate({ specificObjectives: [protocolDraft().specificObjectives[0]] }).errors.join(" "),
    ).toMatch(/2 to 6/);
    const bad = protocolDraft().specificObjectives.map((objective, index) =>
      index === 0 ? { ...objective, verb: "poder diseñar" } : objective,
    );
    expect(validate({ specificObjectives: bad }).errors.join(" ")).toMatch(/single action verb/);
  });

  it("requires every ethics answer and hypotheses for quantitative work", () => {
    const { human_participants: _drop, ...rest } = protocolDraft().ethics;
    expect(validate({ ethics: rest }).errors.join(" ")).toMatch(/ethics.human_participants/);
    expect(validate({ hypotheses: [] }, "quantitative").errors.join(" ")).toMatch(
      /hypotheses is required/,
    );
    expect(
      validate({ hypotheses: ["H1: la precisión supera 0.9"] }, "quantitative").errors,
    ).toEqual([]);
  });

  it("caps text", () => {
    expect(validate({ problem: "x".repeat(2001) }).errors.join(" ")).toMatch(
      /problem must be 1 to 2000/,
    );
  });
});

describe("protocol.md", () => {
  it("allocates objective ids and round-trips through its front matter", () => {
    const text = protocolText();
    const parsed = parseProtocol(text).data as Record<string, unknown>;
    expect(parsed.generalObjective).toMatchObject({ id: "OBJ-G" });
    expect(
      (parsed.specificObjectives as { id: string }[]).map((objective) => objective.id),
    ).toEqual(["OBJ-01", "OBJ-02", "OBJ-03"]);
    expect(text).toContain("## Objetivos específicos");
    expect(text).toContain("**OBJ-02** Implementar la verificación contra Crossref y OpenAlex");
    expect(parseProtocol("no front matter").error).toMatch(/front matter/);
    expect(parseProtocol("---\n: : bad\n---\n").error).toMatch(/YAML/);
  });

  it("renders English labels for other languages", () => {
    expect(protocolText({}, "en")).toContain("## Specific objectives");
  });
});

describe("DSN checks (G1)", () => {
  it("passes a complete protocol", async () => {
    const p = await project({ "thesis.yaml": brief(), "research/protocol.md": protocolText() });
    const report = runChecks(p, { gates: ["G1"] });
    expect(codes(report.findings, "error")).toEqual([]);
    expect(codes(report.findings, "warning")).toEqual([]);
  });

  it("reports DSN-001 for every missing part", async () => {
    const text = protocolText().replace(/problem: .*\n/, "problem: ''\n");
    const missing = await project({ "thesis.yaml": brief(), "research/protocol.md": text });
    const errors = runChecks(missing, { gates: ["G1"] }).findings.filter(
      (finding) => finding.code === "DSN-001",
    );
    expect(errors.map((finding) => finding.message).join(" ")).toMatch(/no problem statement/);
    const broken = await project({
      "thesis.yaml": brief(),
      "research/protocol.md": "---\nschemaVersion: 1\n---\n",
    });
    expect(runChecks(broken, { gates: ["G1"] }).counts.error).toBeGreaterThanOrEqual(5);
    const unreadable = await project({
      "thesis.yaml": brief(),
      "research/protocol.md": "plain text",
    });
    expect(codes(runChecks(unreadable, { gates: ["G1"] }).findings, "error")).toEqual(["DSN-001"]);
  });

  it("flags a protocol with fewer than 2 or more than 6 specific objectives", async () => {
    const draft = validateProtocolDraft(protocolDraft(), { approach: "design_science" })
      .value as ProtocolDraft;
    const data = buildProtocol(draft, {
      language: "es-CO",
      now: new Date("2026-10-04T12:00:00Z"),
      revision: 1,
      ethicsRequirements: [],
    });
    const one = renderProtocol({
      ...data,
      specificObjectives: data.specificObjectives.slice(0, 1),
    });
    const many = renderProtocol({
      ...data,
      specificObjectives: Array.from({ length: 7 }, (_, index) => ({
        ...data.specificObjectives[0]!,
        id: `OBJ-0${index + 1}`,
      })),
    });
    for (const [text, found] of [
      [one, 1],
      [many, 7],
    ] as const) {
      const p = await project({ "thesis.yaml": brief(), "research/protocol.md": text });
      expect(
        runChecks(p, { gates: ["G1"] })
          .findings.map((finding) => finding.message)
          .join(" "),
      ).toContain(`2 to 6 specific objectives (found ${found})`);
    }
  });

  it("warns about verbs outside the approved list and unverifiable verbs (DSN-002)", async () => {
    const draft = protocolDraft().specificObjectives.map((objective, index) =>
      index === 0
        ? { ...objective, verb: "comprender" }
        : index === 1
          ? { ...objective, verb: "conocer" }
          : { ...objective, verb: "bailar" },
    );
    const p = await project({
      "thesis.yaml": brief(),
      "research/protocol.md": protocolText({ specificObjectives: draft }),
    });
    const findings = runChecks(p, { gates: ["G1"] }).findings.filter(
      (finding) => finding.code === "DSN-002",
    );
    expect(findings.map((finding) => finding.severity)).toEqual(["warning", "warning", "warning"]);
    expect(findings.map((finding) => finding.message).join(" ")).toMatch(
      /not verifiable[\s\S]*not verifiable[\s\S]*not in the approved list/,
    );
  });

  it("downgrades 'comprender' to info for a qualitative approach", async () => {
    const draft = protocolDraft().specificObjectives.map((objective, index) =>
      index === 0 ? { ...objective, verb: "comprender" } : objective,
    );
    const p = await project({
      "thesis.yaml": brief().replace("approach: design_science", "approach: qualitative"),
      "research/protocol.md": protocolText({ specificObjectives: draft }),
    });
    const findings = runChecks(p, { gates: ["G1"] }).findings.filter(
      (finding) => finding.code === "DSN-002",
    );
    expect(findings.map((finding) => finding.severity)).toEqual(["info"]);
  });

  it("uses the English list for English theses and says so when no list exists", async () => {
    const english = await project({
      "thesis.yaml": brief().replace("es-CO", "en"),
      "research/protocol.md": protocolText({}, "en"),
    });
    expect(codes(runChecks(english, { gates: ["G1"] }).findings, "warning")).toContain("DSN-002");
    const french = await project({
      "thesis.yaml": brief().replace("es-CO", "fr"),
      "research/protocol.md": protocolText({}, "fr"),
    });
    expect(
      runChecks(french, { gates: ["G1"] }).findings.find((finding) => finding.code === "DSN-002")
        ?.severity,
    ).toBe("info");
  });

  it("reports nothing before a protocol exists", async () => {
    const p = await project({ "thesis.yaml": brief() });
    expect(runChecks(p, { gates: ["G1"] }).findings).toEqual([]);
  });
});

describe("OutlineDraft", () => {
  const ids = ["OBJ-G", "OBJ-01", "OBJ-02", "OBJ-03"];
  it("accepts the fixture outline", () => {
    expect(validateOutlineDraft(outlineDraft(), { objectiveIds: ids }).errors).toEqual([]);
  });

  it("rejects duplicate keys, unknown dependencies and unknown objectives", () => {
    const draft = outlineDraft();
    draft.sections[1]!.key = "resumen";
    draft.sections[2]!.dependsOn = ["nope"];
    draft.sections[3]!.objectives = ["OBJ-09"];
    const errors = validateOutlineDraft(draft, { objectiveIds: ids }).errors.join(" ");
    expect(errors).toMatch(/used twice/);
    expect(errors).toMatch(/unknown section key "nope"/);
    expect(errors).toMatch(/unknown objective OBJ-09/);
  });

  it("limits nesting, topics and purpose length", () => {
    const draft = outlineDraft();
    const deep = {
      ...draft.sections[0]!,
      key: "d1",
      children: [
        {
          ...draft.sections[0]!,
          key: "d2",
          children: [
            {
              ...draft.sections[0]!,
              key: "d3",
              children: [{ ...draft.sections[0]!, key: "d4", children: [] }],
            },
          ],
        },
      ],
    };
    expect(
      validateOutlineDraft({ sections: [deep] }, { objectiveIds: ids }).errors.join(" "),
    ).toMatch(/at most three levels/);
    draft.sections[0]!.researchTopics = [];
    draft.sections[0]!.purpose = "x".repeat(301);
    const errors = validateOutlineDraft(draft, { objectiveIds: ids }).errors.join(" ");
    expect(errors).toMatch(/researchTopics must hold 1 to 8/);
    expect(errors).toMatch(/purpose must be 1 to 300/);
  });
});

describe("outline.json and OUT checks (G4)", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const build = (mutate?: (draft: ReturnType<typeof outlineDraft>) => void) => {
    const draft = outlineDraft();
    mutate?.(draft);
    return buildOutline(draft, { language: "es-CO", now });
  };
  const run = async (document: unknown, protocol = protocolText()) => {
    const p = await project({
      "thesis.yaml": brief(),
      "research/protocol.md": protocol,
      "outline/outline.json": typeof document === "string" ? document : canonicalJson(document),
    });
    return runChecks(p, { gates: ["G4"] }).findings;
  };

  it("allocates SEC ids in document order, nested ids included", () => {
    const outline = build();
    expect(outline.sections[0]?.id).toBe("SEC-01");
    const ids = flattenOutline(outline.sections).map((node) => node.id);
    expect(ids).toContain("SEC-07.01");
    expect(ids).toEqual([...ids].sort());
    expect(
      flattenOutline(outline.sections).find((node) => node.key === "metodologia")?.dependsOn,
    ).toEqual(["SEC-07"]);
    expect(parseOutline(canonicalJson(outline)).errors).toEqual([]);
  });

  it("passes the fixture outline", async () => {
    expect(codes(await run(build()), "error")).toEqual([]);
  });

  it("fails OUT-003 when a specific objective has no section", async () => {
    const findings = await run(
      build((draft) => {
        for (const section of draft.sections)
          section.objectives = section.objectives.filter((objective) => objective !== "OBJ-03");
      }),
    );
    expect(
      findings.filter((finding) => finding.code === "OUT-003").map((finding) => finding.message),
    ).toEqual(["Specific objective OBJ-03 is not covered by any section"]);
  });

  it("fails OUT-002 for a cycle and for a dangling dependency", async () => {
    const cyclic = build((draft) => {
      draft.sections[7]!.dependsOn = ["conclusiones"];
    });
    const findings = await run(cyclic);
    expect(findings.find((finding) => finding.code === "OUT-002")?.message).toMatch(/cycle: .*->/);
    const dangling = build();
    dangling.sections[0]!.dependsOn = ["SEC-99"];
    expect(
      (await run(dangling)).some(
        (finding) => finding.code === "OUT-002" && /unknown section SEC-99/.test(finding.message),
      ),
    ).toBe(true);
  });

  it("fails OUT-004 and OUT-005 for missing and misordered required sections", async () => {
    const missing = await run(
      build((draft) => {
        draft.sections = draft.sections
          .filter((section) => section.key !== "discusion")
          .map((section) => ({
            ...section,
            dependsOn: section.dependsOn.filter((key) => key !== "discusion"),
          }));
      }),
    );
    expect(
      missing.filter((finding) => finding.code === "OUT-004").map((finding) => finding.message),
    ).toEqual(['Required section "discusion" is missing']);
    const swapped = await run(
      build((draft) => {
        const a = draft.sections.findIndex((section) => section.key === "metodologia");
        const b = draft.sections.findIndex((section) => section.key === "marco");
        [draft.sections[a], draft.sections[b]] = [draft.sections[b]!, draft.sections[a]!];
      }),
    );
    expect(swapped.find((finding) => finding.code === "OUT-005")?.message).toBe(
      'Required section "metodologia" must come after "marco_teorico"'.replace(
        "must come after",
        "must come after",
      ),
    );
  });

  it("fails OUT-001 for duplicate ids, wrong parents and malformed files", async () => {
    const duplicate = build();
    (duplicate.sections[1] as { id: string }).id = "SEC-01";
    expect(
      (await run(duplicate)).some(
        (finding) => finding.code === "OUT-001" && /more than once/.test(finding.message),
      ),
    ).toBe(true);
    const misplaced = build();
    (misplaced.sections[6]!.children[0] as { id: string }).id = "SEC-09.01";
    expect(
      (await run(misplaced)).some(
        (finding) =>
          finding.code === "OUT-001" && /not numbered under its parent/.test(finding.message),
      ),
    ).toBe(true);
    expect(codes(await run("{not json"), "error")).toEqual(["OUT-001"]);
    expect(codes(await run('{"schemaVersion":1,"sections":[{"id":"x"}]}'), "error")).toContain(
      "OUT-001",
    );
  });

  it("flags unknown objectives (OUT-006) and sections that serve nothing (OUT-007)", async () => {
    const findings = await run(
      build((draft) => {
        draft.sections[0]!.objectives = ["OBJ-77"];
        draft.sections[6]!.children[0]!.objectives = [];
      }),
    );
    expect(
      findings.some((finding) => finding.code === "OUT-006" && finding.severity === "error"),
    ).toBe(true);
    expect(
      findings.some((finding) => finding.code === "OUT-007" && finding.severity === "warning"),
    ).toBe(true);
  });

  it("enforces the ICONTEC body order when that standard applies", async () => {
    const p = await project({
      "thesis.yaml": brief()
        .replace(
          "presentation: { standard: apa-7 }",
          "presentation: { standard: icontec-ntc1486-2022 }",
        )
        .replace("citationStyle: apa-7", "citationStyle: icontec-ntc1486-2022"),
    });
    const required = requiredSections(p.profile);
    expect(required.groups.map((group) => group.id)).toContain("recomendaciones");
    expect(required.groups.map((group) => group.id)).not.toContain("portada");
    const findings = outlineFindings(canonicalJson(build()), {
      specificObjectiveIds: ["OBJ-01"],
      allObjectiveIds: ["OBJ-G", "OBJ-01"],
      profile: p.profile,
    });
    expect(
      findings.some(
        (finding) => finding.code === "OUT-004" && /recomendaciones/.test(finding.message),
      ),
    ).toBe(true);
  });

  it("renders outline.md with a coverage matrix and nothing before an outline exists", async () => {
    const outline = build();
    const markdown = renderOutlineMarkdown(outline, {
      objectives: [{ id: "OBJ-01", text: "Diseñar un modelo" }],
    });
    expect(markdown).toContain("## SEC-07 Marco teórico (Sección obligatoria: marco_teorico)");
    expect(markdown).toContain("- OBJ-01 Diseñar un modelo: SEC-06, SEC-07, SEC-07.01");
    const none = await project({ "thesis.yaml": brief() });
    expect(runChecks(none, { gates: ["G4"] }).findings).toEqual([]);
  });
});
