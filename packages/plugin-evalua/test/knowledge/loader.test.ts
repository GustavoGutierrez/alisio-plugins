import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { familyIds } from "../../src/families/index.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { CheckReport } from "../../src/knowledge/report.js";
import { cleanup, scratchDir } from "../helpers/harness.js";

afterEach(cleanup);

const ALL = ["basico", "intermedio", "avanzado", "genio"];

function levels(badMix = false): string {
  const reason = badMix ? 30 : 10;
  return `levels:
  basico:
    steps: [1, 2]
    coefficientRange: [-9, 9]
    cognitiveMix: { recall: 50, apply: 40, reason: ${reason} }
    secondsPerItem: 60
  intermedio:
    steps: [2, 3]
    coefficientRange: [-15, 15]
    cognitiveMix: { recall: 30, apply: 50, reason: 20 }
    secondsPerItem: 100
  avanzado:
    steps: [3, 5]
    coefficientRange: [-30, 30]
    cognitiveMix: { recall: 20, apply: 45, reason: 35 }
    secondsPerItem: 150
  genio:
    steps: [4, 8]
    coefficientRange: [-60, 60]
    cognitiveMix: { recall: 10, apply: 35, reason: 55 }
    secondsPerItem: 240
`;
}

interface PackOptions {
  requires?: string[];
  extendsId?: string;
  overrides?: boolean;
  badMix?: boolean;
  missingLevel?: boolean;
}

function packFile(id: string, code: string, options: PackOptions = {}): string {
  const all = levels(options.badMix === true);
  return [
    "schemaVersion: 1",
    `id: ${id}`,
    "version: 1",
    `name: { es: "${id}" }`,
    `code: ${code}`,
    `requires: [${(options.requires ?? []).join(", ")}]`,
    `extends: ${options.extendsId ?? "null"}`,
    `overrides: ${options.overrides === true}`,
    all,
  ].join("\n");
}

function familyTopic(
  id: string,
  code: string,
  family: string,
  {
    levels: declared = ALL,
    objectives = declared,
  }: { levels?: string[]; objectives?: string[] } = {},
): string {
  return [
    `id: ${id}`,
    `name: { es: "${id}" }`,
    `code: ${code}`,
    `grades: ["Séptimo"]`,
    "prerequisites: []",
    "objectives:",
    "  - id: objective-one",
    '    text: { es: "Objetivo." }',
    `    levels: [${objectives.join(", ")}]`,
    "keywords: []",
    "supports: { single_choice: true }",
    "sources:",
    `  - { kind: family, family: ${family}, levels: [${declared.join(", ")}] }`,
  ].join("\n");
}

function bankTopic(id: string, code: string, file: string): string {
  return [
    `id: ${id}`,
    `name: { es: "${id}" }`,
    `code: ${code}`,
    `grades: ["Séptimo"]`,
    "prerequisites: []",
    "objectives:",
    "  - id: objective-one",
    '    text: { es: "Objetivo." }',
    `    levels: [${ALL.join(", ")}]`,
    "keywords: []",
    "supports: { single_choice: true }",
    "sources:",
    `  - { kind: bank, file: ${file} }`,
  ].join("\n");
}

function itemFile(answer: string, check: string): string {
  return [
    "- id: item-one",
    "  type: single_choice",
    "  level: basico",
    '  stem: ["1 + 1"]',
    "  options:",
    '    - { key: A, text: "2", correct: true, error: "none" }',
    '    - { key: B, text: "1", correct: false, error: "off-by-one" }',
    `  answer: { canonical: "${answer}", display: "${answer}" }`,
    '  solution: ["1 + 1 = 2"]',
    `  check: { kind: rational-equal, value: "${check}" }`,
  ].join("\n");
}

async function writePack(
  root: string,
  id: string,
  pack: string,
  topics: Record<string, string> = {},
  items: Record<string, string> = {},
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "topics"), { recursive: true });
  await writeFile(join(dir, "pack.yaml"), pack);
  for (const [name, text] of Object.entries(topics)) {
    await writeFile(join(dir, "topics", name), text);
  }
  if (Object.keys(items).length > 0) {
    await mkdir(join(dir, "items"), { recursive: true });
    for (const [name, text] of Object.entries(items)) {
      await writeFile(join(dir, "items", name), text);
    }
  }
}

const load = (root: string, families: readonly string[] = familyIds) =>
  loadKnowledge({ shippedDir: join(root, "__no_shipped__"), workspaceDirs: [root], families });

function ids(report: CheckReport): string[] {
  return report.results.map((finding) => finding.id);
}

describe("shipped basic-math pack", () => {
  it("loads clean with four calibrated levels and its topics", async () => {
    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      families: familyIds,
    });
    expect(knowledge.report.results).toEqual([]);
    expect(knowledge.report.ok).toBe(true);
    expect(knowledge.packs.map((pack) => pack.id)).toEqual(["algebra", "basic-math"]);
    const pack = knowledge.packs.find((entry) => entry.id === "basic-math");
    expect(pack?.levels.basico.steps).toEqual([1, 2]);
    expect(pack?.levels.genio.coefficientRange).toEqual([-60, 60]);
    const fullIds = knowledge.topics.map((topic) => topic.fullId);
    expect(fullIds).toContain("basic-math/fractions");
    expect(fullIds).toContain("basic-math/percentages");
    const naturals = knowledge.topics.find(
      (topic) => topic.fullId === "basic-math/natural-numbers",
    );
    expect(naturals?.bankItems.length).toBe(3);
    const fractions = knowledge.topics.find((topic) => topic.fullId === "basic-math/fractions");
    expect(fractions?.sources.filter((source) => source.kind === "family")).toHaveLength(2);
  });
});

describe("layering and collisions (EVL-KB-002)", () => {
  it("refuses an id collision without overrides and keeps the shipped pack", async () => {
    const root = await scratchDir();
    await writePack(root, "basic-math", packFile("basic-math", "XXX"));
    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      workspaceDirs: [root],
      families: familyIds,
    });
    expect(ids(knowledge.report)).toContain("EVL-KB-002");
    expect(knowledge.report.ok).toBe(false);
    const basicMath = knowledge.packs.find((entry) => entry.id === "basic-math");
    expect(basicMath?.code).toBe("BAS");
    expect(knowledge.packs).toHaveLength(2);
  });

  it("replaces a shipped pack when overrides is true", async () => {
    const root = await scratchDir();
    await writePack(
      root,
      "algebra",
      packFile("algebra", "ALG", { overrides: true, requires: ["basic-math"] }),
      { "custom-topic.yaml": familyTopic("custom-topic", "CUS", "integer-ops") },
    );
    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      workspaceDirs: [root],
      families: familyIds,
    });
    expect(knowledge.report.ok).toBe(true);
    const algebra = knowledge.packs.find((entry) => entry.id === "algebra");
    expect(algebra?.layer).toBe("workspace");
    const overridden = knowledge.topics.filter((topic) => topic.packId === "algebra");
    expect(overridden.map((topic) => topic.id)).toEqual(["custom-topic"]);
  });

  it("rejects a duplicate pack code across packs", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    await writePack(root, "pack-b", packFile("pack-b", "AAA"), {
      "topic-b.yaml": familyTopic("topic-b", "TBB", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-002");
  });

  it("rejects a duplicate topic code inside one pack", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
      "topic-b.yaml": familyTopic("topic-b", "TAA", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-002");
  });
});

describe("requires and extends (EVL-KB-003)", () => {
  it("reports an unresolved requires", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA", { requires: ["ghost"] }), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-003");
    expect(knowledge.report.results[0]?.message).toMatch(/ghost/);
  });

  it("reports a requires cycle", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA", { requires: ["pack-b"] }), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    await writePack(root, "pack-b", packFile("pack-b", "BBB", { requires: ["pack-a"] }), {
      "topic-b.yaml": familyTopic("topic-b", "TBB", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-003");
    expect(knowledge.report.results.some((finding) => /cycle/.test(finding.message))).toBe(true);
  });

  it("inherits topics through extends and requires overrides to replace one", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "base.yaml": familyTopic("base", "BAA", "integer-ops"),
    });
    await writePack(root, "pack-b", packFile("pack-b", "BBB", { extendsId: "pack-a" }), {
      "child.yaml": familyTopic("child", "CHB", "gcd-lcm"),
    });
    const inherited = await load(root);
    expect(inherited.report.ok).toBe(true);
    const packB = inherited.packs.find((pack) => pack.id === "pack-b");
    expect(packB?.topics.map((topic) => topic.fullId)).toEqual(["pack-b/base", "pack-b/child"]);

    const clash = await scratchDir();
    await writePack(clash, "pack-a", packFile("pack-a", "AAA"), {
      "base.yaml": familyTopic("base", "BAA", "integer-ops"),
    });
    await writePack(clash, "pack-b", packFile("pack-b", "BBB", { extendsId: "pack-a" }), {
      "base.yaml": familyTopic("base", "BAB", "integer-ops"),
    });
    const collision = await load(clash);
    expect(ids(collision.report)).toContain("EVL-KB-002");
  });
});

describe("topic sources (EVL-KB-004)", () => {
  it("reports an unknown family", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "does-not-exist"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-004");
  });

  it("reports a missing bank file", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": bankTopic("topic-a", "TAA", "items/ghost.yaml"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-004");
  });

  it("reports an unknown prerequisite", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops").replace(
        "prerequisites: []",
        "prerequisites: [ghost-topic]",
      ),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-004");
  });
});

describe("calibration and objectives (EVL-KB-005, EVL-KB-006)", () => {
  it("reports a cognitive mix that does not sum to 100", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA", { badMix: true }), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-005");
  });

  it("warns when an objective misses a declared level", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", packFile("pack-a", "AAA"), {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops", {
        levels: ALL,
        objectives: ["basico"],
      }),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-006");
    expect(knowledge.report.ok).toBe(true);
    expect(knowledge.report.results.every((finding) => finding.severity === "warning")).toBe(true);
  });
});

describe("schema and static checks (EVL-KB-001, EVL-KB-007)", () => {
  it("rejects YAML aliases and oversized files", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", `${packFile("pack-a", "AAA")}\nextra: &x 1\nother: *x\n`, {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-001");
  });

  it("rejects a malformed pack schema", async () => {
    const root = await scratchDir();
    await writePack(root, "pack-a", "schemaVersion: 1\nid: pack-a\nversion: 1\n", {
      "topic-a.yaml": familyTopic("topic-a", "TAA", "integer-ops"),
    });
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-001");
  });

  it("reports a static item whose check disagrees with its answer", async () => {
    const root = await scratchDir();
    await writePack(
      root,
      "pack-a",
      packFile("pack-a", "AAA"),
      { "topic-a.yaml": bankTopic("topic-a", "TAA", "items/bank.yaml") },
      { "bank.yaml": itemFile("2", "3") },
    );
    const knowledge = await load(root);
    expect(ids(knowledge.report)).toContain("EVL-KB-007");
  });

  it("accepts a static item whose check matches", async () => {
    const root = await scratchDir();
    await writePack(
      root,
      "pack-a",
      packFile("pack-a", "AAA"),
      { "topic-a.yaml": bankTopic("topic-a", "TAA", "items/bank.yaml") },
      { "bank.yaml": itemFile("2", "2") },
    );
    const knowledge = await load(root);
    expect(knowledge.report.ok).toBe(true);
    expect(knowledge.topics[0]?.bankItems).toHaveLength(1);
  });
});
