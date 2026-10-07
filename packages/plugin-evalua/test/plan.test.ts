import { describe, expect, it } from "vitest";
import type { ExamItem } from "../src/generate.js";
import { freezeItems, itemsSha256, parseItemsFile } from "../src/items-file.js";
import { buildPlanProject, buildVersionLog, type PlanInput } from "../src/plan.js";

const item: ExamItem = {
  id: "basic-math/integers/x#s=1",
  ref: "INT-0001",
  topic: "basic-math/integers",
  family: "integer-ops",
  source: "generator",
  type: "single_choice",
  level: "basico",
  cognitive: "apply",
  stem: ["$1 + 1$"],
  options: [
    { key: "A", value: "2", display: "$2$", correct: true, error: "none" },
    { key: "B", value: "3", display: "$3$", correct: false, error: "off-by-one" },
  ],
  answer: { canonical: "2", display: "$2$" },
  solution: ["$1 + 1 = 2$"],
  points: 1,
  estimatedSeconds: 60,
  check: { kind: "recomputed", verifiedBy: "integer-ops" },
};

const planInput: PlanInput = {
  examId: "e01",
  title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
  theme: "CONJUNTO DE LOS NÚMEROS RACIONALES (Q)",
  grade: "Séptimo",
  level: "basico",
  questionCount: 5,
  itemTypes: { single_choice: 3, multiple_choice: 0, open: 0, practice: 2 },
  packs: ["basic-math"],
  topics: ["basic-math/integers"],
  schoolYear: 2026,
  revision: 1,
  gates: { a: { decision: "approved", at: "2026-10-06T12:00:00.000Z" } },
  phases: [
    { name: "Item generation", status: "done", at: "2026-10-06T12:05:00.000Z" },
    { name: "Layout fit", status: "pending" },
  ],
  seeds: ["e01|A|generator"],
  pluginVersion: "0.0.0",
  itemsSha256: "abc",
  engine: "Chrome/154",
  builtAt: "2026-10-06T12:10:00.000Z",
};

describe("items.json", () => {
  it("freezes to canonical JSON and reads back the items", () => {
    const frozen = freezeItems([item]);
    expect(frozen).toContain('"schemaVersion": 1');
    expect(parseItemsFile(frozen)).toEqual([item]);
    expect(itemsSha256(frozen)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a malformed file and drops unknown entries", () => {
    expect(() => parseItemsFile("nope")).toThrow(/JSON/);
    expect(() => parseItemsFile('{"schemaVersion":2,"items":[]}')).toThrow(/schemaVersion/);
    expect(parseItemsFile('{"schemaVersion":1,"items":[{"nope":true}]}')).toEqual([]);
  });
});

describe("plan and version documents", () => {
  it("builds the project plan with the schedule, matrix and approval record", () => {
    const plan = buildPlanProject(planInput);
    expect(plan).toContain("# Plan del proyecto");
    expect(plan).toContain("| Item generation | done |");
    expect(plan).toContain("| Coordinador de evaluación |");
    expect(plan).toContain("| a | approved | 2026-10-06T12:00:00.000Z |");
  });

  it("builds the version log with the seeds, engine, hash and gates", () => {
    const log = buildVersionLog(planInput);
    expect(log).toContain("- Revisión: 1");
    expect(log).toContain("- Motor: Chrome/154");
    expect(log).toContain("- SHA-256 de items.json: abc");
    expect(log).toContain("| a | approved |");
  });
});
