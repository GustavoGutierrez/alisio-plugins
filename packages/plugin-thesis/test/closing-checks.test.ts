import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, runChecks } from "../src/checks/index.js";
import { guessLanguage, looksForeign } from "../src/checks/language.js";
import { sentencesOf } from "../src/checks/writing.js";
import { claimId, serializeClaims } from "../src/claims.js";
import { defaultState } from "../src/storage.js";
import type { ClaimRecord, Finding, Gate, ThesisState } from "../src/types.js";
import { cleanSamples, sampleThesis } from "./helpers/sample.js";

afterEach(cleanSamples);

const codes = (findings: Finding[], code: string) => findings.filter((f) => f.code === code);

async function check(dir: string, gates: Gate[], state?: ThesisState) {
  return runChecks(await loadProject(dir, state ? { state } : {}), { gates }).findings;
}

const append = async (dir: string, file: string, text: string) => {
  const path = join(dir, file);
  await writeFile(path, `${await readFile(path, "utf8")}\n${text}\n`);
};

const claimRecord = (over: Partial<ClaimRecord>, index = 1): ClaimRecord => ({
  id: claimId(index),
  section: "SEC-01",
  anchor: `c${index}`,
  text: "Afirmación de prueba.",
  kind: "background",
  evidence: ["EVD-00001"],
  objectives: [],
  ...over,
});

function stateIn(phase: ThesisState["phase"], sections: ThesisState["sections"] = {}): ThesisState {
  const state = defaultState();
  state.phase = phase;
  state.sections = sections;
  return state;
}

describe("CIT-001 to CIT-003 (G5)", () => {
  it("passes on the sample thesis", async () => {
    const dir = await sampleThesis();
    expect(await check(dir, ["G5"])).toEqual([]);
  });

  it("CIT-001: a key that is not in the library", async () => {
    const dir = await sampleThesis();
    await append(dir, "chapters/01-introduccion.md", "Una fuente inventada [@inventado2020].");
    const [found] = codes(await check(dir, ["G5"]), "CIT-001");
    expect(found).toMatchObject({
      severity: "error",
      file: "chapters/01-introduccion.md",
      section: "SEC-01",
    });
    expect(found?.message).toContain("@inventado2020");
  });

  it("CIT-002: a record that is not citable for the section", async () => {
    const dir = await sampleThesis();
    const path = join(dir, "evidence", "library.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0] as string), status: "CONTEXTUAL_ONLY" });
    await writeFile(path, `${lines.join("\n")}\n`);
    const findings = codes(await check(dir, ["G5"]), "CIT-002");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain("CONTEXTUAL_ONLY");
    // An explicit approval for the section makes it citable.
    const state = stateIn("sections", {
      "SEC-01": { status: "draft_review", contextualApprovals: ["EVD-00001"] },
    });
    const approved = codes(await check(dir, ["G5"], state), "CIT-002");
    expect(approved.filter((f) => f.section === "SEC-01")).toEqual([]);
    // The abstract declares no section, so it has no approval to lean on.
    expect(approved.map((f) => f.file)).toEqual(["chapters/00-resumen.md"]);
  });

  it("CIT-003: unused library records matter only from the review phase on", async () => {
    const dir = await sampleThesis();
    await writeFile(
      join(dir, "chapters", "02-metodologia.md"),
      "---\nsection: SEC-02\n---\n\n# Metodología\n\nTexto.\n",
    );
    await writeFile(
      join(dir, "chapters", "01-introduccion.md"),
      "---\nsection: SEC-01\n---\n\n# Introducción\n\nSolo [@perez2021].\n",
    );
    expect(codes(await check(dir, ["G5"], stateIn("sections")), "CIT-003")).toEqual([]);
    const late = codes(await check(dir, ["G5"], stateIn("review")), "CIT-003");
    expect(late.map((f) => f.message.split(" ")[1])).toEqual(
      expect.arrayContaining(["@garcia2019", "@ley15812012"]),
    );
    expect(late.every((f) => f.severity === "warning")).toBe(true);
  });
});

describe("CLM-001 to CLM-004 (G3, G10)", () => {
  const withAnchors = async (dir: string) => {
    await writeFile(
      join(dir, "chapters", "01-introduccion.md"),
      "---\nsection: SEC-01\n---\n\n# Introducción\n\n<!-- claim:c1 -->\nLa verificación es viable [@perez2021].\n\n<!-- claim:c2 -->\nLa conclusión se sigue de lo anterior [@garcia2019].\n",
    );
  };
  const write = (dir: string, records: ClaimRecord[]) => mkClaims(dir, serializeClaims(records));
  const mkClaims = async (dir: string, text: string) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "claims"), { recursive: true });
    await writeFile(join(dir, "claims", "claims.jsonl"), text);
  };

  it("passes when anchors and records match both ways", async () => {
    const dir = await sampleThesis();
    await withAnchors(dir);
    await write(dir, [claimRecord({}, 1), claimRecord({ anchor: "c2", kind: "argument" }, 2)]);
    expect(await check(dir, ["G3"])).toEqual([]);
  });

  it("CLM-001: an anchor without a record, and a record without an anchor", async () => {
    const dir = await sampleThesis();
    await withAnchors(dir);
    await write(dir, [claimRecord({}, 1), claimRecord({ anchor: "c9" }, 3)]);
    const messages = codes(await check(dir, ["G3"]), "CLM-001").map((f) => f.message);
    expect(messages.some((m) => m.includes("Claim anchor c2 has no record"))).toBe(true);
    expect(
      messages.some((m) => m.includes("CLM-0003") && m.includes("has no anchor in the text")),
    ).toBe(true);
  });

  it("CLM-001: an anchor in a file that declares no section", async () => {
    const dir = await sampleThesis();
    await writeFile(
      join(dir, "chapters", "01-introduccion.md"),
      "# Introducción\n\n<!-- claim:c1 -->\nTexto [@perez2021].\n",
    );
    await write(dir, [claimRecord({})]);
    expect(
      codes(await check(dir, ["G3"]), "CLM-001").some((f) =>
        f.message.includes("declares no section"),
      ),
    ).toBe(true);
  });

  it("CLM-002: evidence must exist, and background claims need some", async () => {
    const dir = await sampleThesis();
    await withAnchors(dir);
    await write(dir, [
      claimRecord({ evidence: ["EVD-09999"] }, 1),
      claimRecord({ anchor: "c2", evidence: [] }, 2),
    ]);
    const messages = codes(await check(dir, ["G3"]), "CLM-002").map((f) => f.message);
    expect(messages.some((m) => m.includes("EVD-09999"))).toBe(true);
    expect(messages.some((m) => m.includes("without evidence"))).toBe(true);
  });

  it("CLM-003: a conclusion without results fails; with a result it passes", async () => {
    const dir = await sampleThesis();
    await withAnchors(dir);
    await write(dir, [
      claimRecord({}, 1),
      claimRecord({ anchor: "c2", kind: "conclusion", evidence: [] }, 2),
    ]);
    const failing = codes(await check(dir, ["G3"]), "CLM-003");
    expect(failing).toHaveLength(1);
    expect(failing[0]?.message).toContain("Conclusion CLM-0002");

    await write(dir, [
      claimRecord({ kind: "result" }, 1),
      claimRecord({ anchor: "c2", kind: "conclusion", evidence: [], results: ["CLM-0001"] }, 2),
    ]);
    expect(codes(await check(dir, ["G3"]), "CLM-003")).toEqual([]);

    // A background claim is not a result.
    await write(dir, [
      claimRecord({ kind: "background" }, 1),
      claimRecord({ anchor: "c2", kind: "conclusion", evidence: [], results: ["CLM-0001"] }, 2),
    ]);
    expect(codes(await check(dir, ["G3"]), "CLM-003")).toHaveLength(1);
    // An unknown claim is reported.
    await write(dir, [
      claimRecord({ kind: "result" }, 1),
      claimRecord({ anchor: "c2", kind: "conclusion", evidence: [], results: ["CLM-0077"] }, 2),
    ]);
    expect(
      codes(await check(dir, ["G3"]), "CLM-003").some((f) => f.message.includes("CLM-0077")),
    ).toBe(true);
  });

  it("CLM-003: a theoretical thesis may conclude from argument claims", async () => {
    const dir = await sampleThesis();
    await withAnchors(dir);
    const brief = join(dir, "thesis.yaml");
    await writeFile(
      brief,
      (await readFile(brief, "utf8")).replace("approach: design_science", "approach: theoretical"),
    );
    await write(dir, [
      claimRecord({ kind: "argument" }, 1),
      claimRecord({ anchor: "c2", kind: "conclusion", evidence: [], results: ["CLM-0001"] }, 2),
    ]);
    expect(codes(await check(dir, ["G3"]), "CLM-003")).toEqual([]);
  });

  it("CLM-004: every objective must be reached by a result or a conclusion (G10, review phase)", async () => {
    const dir = await sampleThesis();
    await writeFile(
      join(dir, "research", "protocol.md"),
      "---\ngeneralObjective: { id: OBJ-G, text: x }\nspecificObjectives:\n  - { id: OBJ-01, verb: a, object: b, deliverable: c }\n---\n",
    ).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "research"), { recursive: true });
      await writeFile(
        join(dir, "research", "protocol.md"),
        "---\ngeneralObjective: { id: OBJ-G, text: x }\nspecificObjectives:\n  - { id: OBJ-01, verb: a, object: b, deliverable: c }\n---\n",
      );
    });
    await write(dir, [claimRecord({ kind: "result", objectives: ["OBJ-G"] })]);
    expect(codes(await check(dir, ["G10"], stateIn("sections")), "CLM-004")).toEqual([]);
    const late = codes(await check(dir, ["G10"], stateIn("review")), "CLM-004");
    expect(late.map((f) => f.message)).toEqual([
      "Objective OBJ-01 is not reached by any result or conclusion claim",
    ]);
    await write(dir, [claimRecord({ kind: "result", objectives: ["OBJ-G", "OBJ-01"] })]);
    expect(codes(await check(dir, ["G10"], stateIn("review")), "CLM-004")).toEqual([]);
  });
});

describe("LNG-001 (G7)", () => {
  const spanish =
    "La verificación automática de las referencias es una necesidad de los trabajos de grado porque los estudiantes suelen citar fuentes que no han leído y que no respaldan lo que se afirma en el texto de su documento final.";
  const english =
    "The automatic verification of the references is a need of the theses because the students often cite sources that they have not read and that do not support what is stated in the text of their final document.";
  const portuguese =
    "A verificação automática das referências é uma necessidade dos trabalhos de conclusão porque os estudantes costumam citar fontes que não leram e que não sustentam o que se afirma no texto do seu documento final.";

  it("recognizes the four languages", () => {
    expect(guessLanguage(spanish).best).toBe("es");
    expect(guessLanguage(english).best).toBe("en");
    expect(guessLanguage(portuguese).best).toBe("pt");
    expect(looksForeign(spanish, "es")).toBeUndefined();
    expect(looksForeign(english, "es")?.best).toBe("en");
    expect(looksForeign("Muy corto.", "es")).toBeUndefined();
    expect(looksForeign(english, "de")).toBeUndefined(); // not one of the four: not judged
  });

  it("flags an English section in a Spanish thesis, and nothing for Spanish ones", async () => {
    const dir = await sampleThesis();
    expect(codes(await check(dir, ["G7"]), "LNG-001")).toEqual([]);
    await writeFile(
      join(dir, "chapters", "02-metodologia.md"),
      `---\nsection: SEC-02\n---\n\n# Methodology\n\n${english} ${english}\n`,
    );
    const [found] = codes(await check(dir, ["G7"]), "LNG-001");
    expect(found).toMatchObject({
      severity: "warning",
      file: "chapters/02-metodologia.md",
      section: "SEC-02",
    });
    expect(found?.message).toContain("looks en but should be es");
  });

  it("judges an abstract by its declared language", async () => {
    const dir = await sampleThesis();
    // The secondary abstract is declared English: Spanish text in it is wrong, English is right.
    await writeFile(
      join(dir, "chapters", "00-abstract-en.md"),
      `---\nrole: abstract-secondary\nlang: en\nkeywords: [a, b, c]\n---\n\n${spanish}\n`,
    );
    const [found] = codes(await check(dir, ["G7"]), "LNG-001");
    expect(found?.file).toBe("chapters/00-abstract-en.md");
    expect(found?.message).toContain("looks es but should be en");
    await writeFile(
      join(dir, "chapters", "00-abstract-en.md"),
      `---\nrole: abstract-secondary\nlang: en\nkeywords: [a, b, c]\n---\n\n${english}\n`,
    );
    expect(codes(await check(dir, ["G7"]), "LNG-001")).toEqual([]);
  });
});

describe("WRT checks (G7)", () => {
  const filler = (words: number) =>
    Array.from(
      { length: Math.ceil(words / 9) },
      (_, i) => `La frase número ${i} describe el procedimiento con claridad.`,
    ).join(" ");

  it("WRT-003: a sentence of more than 45 words", async () => {
    const dir = await sampleThesis();
    const long = `${"palabra ".repeat(50).trim()}.`;
    await append(dir, "chapters/01-introduccion.md", `${long} Fin.`);
    const found = codes(await check(dir, ["G7"]), "WRT-003");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("50 words");
    expect(sentencesOf("Una frase. Otra frase. ¿Una pregunta? Sí.")).toHaveLength(4);
  });

  it("WRT-004: paragraphs that open the same way", async () => {
    const dir = await sampleThesis();
    await append(
      dir,
      "chapters/01-introduccion.md",
      "En este trabajo se estudia el método.\n\nEn este trabajo se mide el error.",
    );
    expect(
      codes(await check(dir, ["G7"]), "WRT-004").some((f) =>
        f.message.includes('"en este trabajo"'),
      ),
    ).toBe(true);
  });

  it("WRT-002: abstract limit from the policy (250 words)", async () => {
    const dir = await sampleThesis();
    await writeFile(
      join(dir, "chapters", "00-resumen.md"),
      `---\nrole: abstract\nlang: es\nkeywords: [a, b, c]\n---\n\n${filler(300)}\n`,
    );
    const [found] = codes(await check(dir, ["G7"]), "WRT-002");
    expect(found?.message).toMatch(/The abstract has \d+ words; the policy limit is 250/);
  });

  it("WRT-001: word count against the outline target", async () => {
    const dir = await sampleThesis();
    const outline = {
      schemaVersion: 1,
      language: "es-CO",
      generatedAt: "2026-10-04T00:00:00.000Z",
      sections: [
        {
          id: "SEC-02",
          key: "metodologia",
          title: "Metodología",
          purpose: "x",
          objectives: [],
          researchTopics: ["a"],
          questionsToAnswer: [],
          evidenceNeeds: [],
          targetWords: 2000,
          dependsOn: [],
          children: [],
        },
      ],
    };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "outline"), { recursive: true });
    await writeFile(join(dir, "outline", "outline.json"), JSON.stringify(outline));
    const [found] = codes(await check(dir, ["G7"]), "WRT-001");
    expect(found?.message).toMatch(/\d+ words against a target of 2000 \(allowed 1500 to 2500\)/);
    await writeFile(
      join(dir, "outline", "outline.json"),
      JSON.stringify({ ...outline, sections: [{ ...outline.sections[0], targetWords: 100 }] }),
    );
    expect(codes(await check(dir, ["G7"]), "WRT-001")).toEqual([]);
  });
});

describe("ETH-001, POL-AI-001, REV-001, FIN-001", () => {
  const protocolWith = (ethics: Record<string, boolean>, requirements: object[]) =>
    `---\nethics: ${JSON.stringify(ethics)}\nethicsRequirements: ${JSON.stringify(requirements)}\n---\n`;
  const allNo = Object.fromEntries(
    [
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
    ].map((id) => [id, false]),
  );
  const writeProtocol = async (dir: string, text: string) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "research"), { recursive: true });
    await writeFile(join(dir, "research", "protocol.md"), text);
  };

  it("ETH-001: an unanswered questionnaire is an error", async () => {
    const dir = await sampleThesis();
    await writeProtocol(dir, protocolWith({ human_participants: true }, []));
    const [found] = codes(await check(dir, ["G6"]), "ETH-001");
    expect(found).toMatchObject({ severity: "error" });
    expect(found?.message).toContain("incomplete");
  });

  it("ETH-001: a triggered requirement needs a resolution (warning while drafting, error from review)", async () => {
    const dir = await sampleThesis();
    const requirement = {
      id: "ETH-HUMAN_PARTICIPANTS-01",
      trigger: "human_participants",
      ruleId: "R",
      text: "Aprobación del comité",
      generic: false,
    };
    await writeProtocol(dir, protocolWith({ ...allNo, human_participants: true }, [requirement]));
    expect(
      codes(await check(dir, ["G6"], stateIn("sections")), "ETH-001").map((f) => f.severity),
    ).toEqual(["warning"]);
    expect(
      codes(await check(dir, ["G6"], stateIn("review")), "ETH-001").map((f) => f.severity),
    ).toEqual(["error"]);
    const resolved = stateIn("review");
    resolved.ethicsResolutions = {
      "ETH-HUMAN_PARTICIPANTS-01": {
        text: "Acta 12/2026, anexo B",
        at: "2026-10-04T00:00:00.000Z",
      },
    };
    expect(codes(await check(dir, ["G6"], resolved), "ETH-001")).toEqual([]);
  });

  it("POL-AI-001: the declaration is required from the review phase on", async () => {
    const dir = await sampleThesis();
    expect(
      codes(await check(dir, ["G6"], stateIn("sections")), "POL-AI-001").map((f) => f.severity),
    ).toEqual(["warning"]);
    expect(
      codes(await check(dir, ["G6"], stateIn("review")), "POL-AI-001").map((f) => f.severity),
    ).toEqual(["error"]);
    await writeFile(
      join(dir, "chapters", "00-ia.md"),
      "---\nrole: ai-declaration\n---\n\nSe usó un asistente de escritura y el autor revisó todo el contenido.\n",
    );
    expect(codes(await check(dir, ["G6"], stateIn("review")), "POL-AI-001")).toEqual([]);
    // No state (the CLI on a bare folder): nothing to enforce yet.
    const fresh = await sampleThesis();
    expect(codes(await check(fresh, ["G6"]), "POL-AI-001")).toEqual([]);
  });

  it("REV-001: an open critical or major finding is an error; dismissed and minor ones are not", async () => {
    const dir = await sampleThesis();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "reviews"), { recursive: true });
    const finding = (id: string, over: object) =>
      JSON.stringify({
        id,
        severity: "major",
        category: "argument",
        target: "SEC-01",
        evidence: "x",
        description: "No sigue.",
        routeTo: "architect",
        status: "open",
        createdAt: "2026-10-04T00:00:00.000Z",
        ...over,
      });
    await writeFile(join(dir, "reviews", "FND-0001.json"), finding("FND-0001", {}));
    await writeFile(
      join(dir, "reviews", "FND-0002.json"),
      finding("FND-0002", { severity: "minor" }),
    );
    await writeFile(
      join(dir, "reviews", "FND-0003.json"),
      finding("FND-0003", { status: "dismissed" }),
    );
    await writeFile(
      join(dir, "reviews", "FND-0004.json"),
      finding("FND-0004", { severity: "critical", status: "resolved" }),
    );
    const found = codes(await check(dir, ["G9"]), "REV-001");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      file: "reviews/FND-0001.json",
      section: "SEC-01",
    });
    await writeFile(join(dir, "reviews", "FND-0005.json"), "not json");
    expect(codes(await check(dir, ["G9"]), "REV-001")).toHaveLength(2);
  });

  it("FIN-001: reports progress early and the missing final steps late", async () => {
    const dir = await sampleThesis();
    const early = stateIn("sections", {
      "SEC-01": { status: "approved" },
      "SEC-02": { status: "draft_review" },
    });
    const [info] = codes(await check(dir, ["G10"], early), "FIN-001");
    expect(info).toMatchObject({ severity: "info" });
    expect(info?.message).toContain("1 of 2 sections are approved");

    const late = stateIn("review", { "SEC-01": { status: "approved" } });
    const messages = codes(await check(dir, ["G10"], late), "FIN-001").map((f) => f.message);
    expect(messages).toEqual([
      "Human Gate A is not approved",
      "Human Gate B is not approved",
      "Human Gate C is not approved",
      "Human Gate OUTLINE is not approved",
      "The PDF/A build has not succeeded",
    ]);

    for (const gate of ["A", "B", "OUTLINE", "C"] as const)
      late.humanGates[gate] = { status: "approved", at: "2026-10-04T00:00:00.000Z" };
    late.finalBuild = {
      at: "2026-10-04T00:00:00.000Z",
      pdf: "thesis/build/submission/thesis-pdfa.pdf",
      sha256: "0".repeat(64),
    };
    expect(codes(await check(dir, ["G10"], late), "FIN-001")).toEqual([]);
  });
});
