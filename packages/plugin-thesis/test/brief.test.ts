import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyBriefDefaults,
  isValidLanguageTag,
  loadBrief,
  paletteCatalog,
  stringifyBrief,
} from "../src/brief.js";
import { paletteNames } from "../src/types.js";

const minimal = `schemaVersion: 1
language: es-CO
workType: master_thesis
year: 2026
institution: { country: CO }
`;

describe("BCP-47 check", () => {
  it("accepts well-formed tags and rejects malformed ones", () => {
    for (const ok of ["es", "es-CO", "en-US", "pt-BR", "zh-Hant-TW", "fr-CA"]) {
      expect(isValidLanguageTag(ok)).toBe(true);
    }
    for (const bad of ["", "e", "spanish", "es_CO", "es-", "123", "es-CO-", "x-private", "en us"]) {
      expect(isValidLanguageTag(bad)).toBe(false);
    }
  });
});

describe("brief loading", () => {
  it("accepts a minimal brief and fills documented defaults", () => {
    const result = loadBrief(minimal);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const brief = result.brief;
    expect(brief?.citationStyle).toBe("auto");
    expect(brief?.presentation).toEqual({
      standard: "auto",
      paper: "letter",
      fontProfile: "serif",
      palette: "okabe-ito",
      diagramTheme: "neutral",
    });
    expect(brief?.aiUse).toEqual({ assisted: true, declaration: "auto" });
    expect(brief?.searchLanguages).toEqual(["es", "en"]);
    expect(brief?.title).toBeNull();
  });

  it("rejects unknown keys at every level with a line number", () => {
    const text = `${minimal}titel: typo\npresentation:\n  paperr: a4\n`;
    const issues = loadBrief(text).issues.filter((issue) => issue.severity === "error");
    const messages = issues.map((issue) => `${issue.path}|${issue.line}`);
    expect(messages).toContain("titel|6");
    expect(messages).toContain("presentation.paperr|8");
    expect(issues.every((issue) => issue.code === "BRF-002")).toBe(true);
  });

  it("reports YAML syntax and duplicate keys as BRF-001", () => {
    const syntax = loadBrief("language: [unclosed\n");
    expect(syntax.brief).toBeUndefined();
    expect(syntax.issues[0]?.code).toBe("BRF-001");
    const duplicate = loadBrief(`${minimal}year: 2027\n`);
    expect(duplicate.issues.some((issue) => issue.code === "BRF-001")).toBe(true);
    expect(loadBrief("").issues[0]?.code).toBe("BRF-001");
    expect(loadBrief("- a\n- b\n").issues[0]?.code).toBe("BRF-001");
  });

  it("flags an invalid language as BRF-003", () => {
    const issues = loadBrief(minimal.replace("es-CO", "spanish")).issues;
    expect(issues.find((issue) => issue.code === "BRF-003")?.path).toBe("language");
    const secondary = loadBrief(`${minimal}secondaryAbstractLanguage: en_US\n`).issues;
    expect(secondary.find((issue) => issue.code === "BRF-003")?.path).toBe(
      "secondaryAbstractLanguage",
    );
  });

  it("validates enums, types and ranges", () => {
    const bad = `schemaVersion: 2
language: es
workType: phd
year: "2026"
institution: { country: Colombia }
approach: magic
citationStyle: Bad Style
presentation: { paper: legal, palette: neon, standard: Generic!, fontProfile: comic, diagramTheme: rainbow }
targets: { pages: -1, words: 1.5 }
aiUse: { assisted: "yes", declaration: sometimes }
authors: [{ name: "" }]
searchLanguages: []
`;
    const paths = loadBrief(bad)
      .issues.filter((issue) => issue.severity === "error")
      .map((issue) => issue.path);
    for (const expected of [
      "schemaVersion",
      "workType",
      "year",
      "institution.country",
      "approach",
      "citationStyle",
      "presentation.paper",
      "presentation.palette",
      "presentation.standard",
      "presentation.fontProfile",
      "presentation.diagramTheme",
      "targets.pages",
      "targets.words",
      "aiUse.assisted",
      "aiUse.declaration",
      "authors[0].name",
      "searchLanguages",
    ]) {
      expect(paths, expected).toContain(expected);
    }
  });

  it("requires year and country as BRF-005 errors, and warns about missing metadata", () => {
    const result = loadBrief("schemaVersion: 1\nlanguage: en\nworkType: monograph\n");
    const required = result.issues.filter((issue) => issue.code === "BRF-005");
    expect(required.map((issue) => issue.path).sort()).toEqual(["institution.country", "year"]);
    expect(required.every((issue) => issue.severity === "error")).toBe(true);
    const warnings = loadBrief(minimal).issues.filter((issue) => issue.severity === "warning");
    expect(warnings.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["title", "authors", "institution.name"]),
    );
    expect(warnings.every((issue) => issue.code === "BRF-006")).toBe(true);
  });

  it("requires advisors as a warning for master and doctoral work only", () => {
    const hasAdvisorWarning = (text: string) =>
      loadBrief(text).issues.some((issue) => issue.path === "advisors");
    expect(hasAdvisorWarning(minimal)).toBe(true);
    expect(hasAdvisorWarning(minimal.replace("master_thesis", "monograph"))).toBe(false);
  });

  it("resolves workspace style ids through the known-id options", () => {
    const text = `${minimal}citationStyle: thesis-test\n`;
    expect(loadBrief(text).issues.some((issue) => issue.code === "BRF-004")).toBe(true);
    const known = loadBrief(text, { citationStyles: ["thesis-test"] });
    expect(known.issues.some((issue) => issue.code === "BRF-004")).toBe(false);
    const presentation = `${minimal}presentation: { standard: my-school }\n`;
    expect(loadBrief(presentation).issues.some((issue) => issue.code === "BRF-004")).toBe(true);
    expect(
      loadBrief(presentation, { presentationStandards: ["my-school"] }).issues.some(
        (issue) => issue.code === "BRF-004",
      ),
    ).toBe(false);
  });

  it("validates studyDesign and policy.packs", () => {
    expect(
      loadBrief(`${minimal}studyDesign: rct\npolicy: { packs: [CO, my-pack] }\n`).brief,
    ).toMatchObject({
      studyDesign: "rct",
      policy: { packs: ["CO", "my-pack"] },
    });
    expect(loadBrief(minimal).brief).toMatchObject({
      studyDesign: null,
      policy: { packs: "auto" },
    });
    const paths = loadBrief(`${minimal}studyDesign: magic\npolicy: { packs: nope, extra: 1 }\n`)
      .issues.filter((issue) => issue.severity === "error")
      .map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["studyDesign", "policy.packs", "policy.extra"]));
  });

  it("stringifies in spec order and round-trips", () => {
    const brief = applyBriefDefaults({
      language: "es-CO",
      workType: "master_thesis",
      year: 2026,
      institution: { country: "CO" },
    });
    const text = stringifyBrief(brief);
    expect(text.indexOf("schemaVersion")).toBeLessThan(text.indexOf("language"));
    expect(text.indexOf("language")).toBeLessThan(text.indexOf("citationStyle"));
    expect(loadBrief(text).brief).toEqual(brief);
  });

  it("keeps the palette catalog in sync with templates/palettes.json", () => {
    const file = JSON.parse(
      readFileSync(new URL("../templates/palettes.json", import.meta.url), "utf8"),
    ) as { palettes: Record<string, { colors: string[] }> };
    expect(Object.keys(file.palettes).sort()).toEqual([...paletteNames].sort());
    expect(paletteCatalog().sort()).toEqual([...paletteNames].sort());
    expect(file.palettes["okabe-ito"]?.colors).toHaveLength(8);
  });
});
