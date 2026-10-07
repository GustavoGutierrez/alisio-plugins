import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { familyIds } from "../../src/families/index.js";
import { buildRound } from "../../src/interview.js";
import { createTopicCatalog } from "../../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import { cleanup, harness, PROFILE_ANSWERS, ROUND1, ROUND2, ROUND3 } from "../helpers/harness.js";

afterEach(cleanup);

const LEVELS = `levels:
  basico:
    steps: [1, 2]
    coefficientRange: [-9, 9]
    cognitiveMix: { recall: 50, apply: 40, reason: 10 }
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

const PACK = `schemaVersion: 1
id: aa-custom
version: 1
name: { es: "Geometría del taller" }
code: CUS
requires: []
extends: null
overrides: false
${LEVELS}`;

const TOPIC = `id: volume
name: { es: "Volumen del prisma" }
code: VOL
grades: ["Décimo"]
prerequisites: []
objectives:
  - id: prism-volume
    text: { es: "Calcula el volumen de un prisma rectangular." }
    levels: [basico, intermedio, avanzado, genio]
keywords: [volumen, prisma, cuerpo geométrico]
supports: { single_choice: true }
sources:
  - { kind: bank, file: items/volume.yaml }
`;

const ITEM = `- id: volume-prism-2-2-2
  type: single_choice
  level: basico
  stem: ["Un prisma mide 2, 2 y 2. ¿Cuál es su volumen?"]
  options:
    - { key: A, text: "8", correct: true, error: "none" }
    - { key: B, text: "6", correct: false, error: "added-edges" }
  answer: { canonical: "8", display: "8" }
  solution: ["2 x 2 x 2 = 8"]
  check: { kind: rational-equal, value: "8" }
`;

async function writeWorkspacePack(packsDir: string): Promise<void> {
  const dir = join(packsDir, "aa-custom");
  await mkdir(join(dir, "topics"), { recursive: true });
  await mkdir(join(dir, "items"), { recursive: true });
  await writeFile(join(dir, "pack.yaml"), PACK);
  await writeFile(join(dir, "topics", "volume.yaml"), TOPIC);
  await writeFile(join(dir, "items", "volume.yaml"), ITEM);
}

describe("data-only extension (spec 6.6, AD-3)", () => {
  it("validates a workspace pack and offers its new topic in the interview, with no source change", async () => {
    const h = await harness({ answers: [PROFILE_ANSWERS, ROUND1, ROUND2, ROUND3] });
    const packsDir = join(h.workspace, "evalua", "knowledge-packs");
    await writeWorkspacePack(packsDir);

    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      workspaceDirs: [packsDir],
      families: familyIds,
    });
    expect(knowledge.report.ok).toBe(true);
    expect(knowledge.report.results).toEqual([]);
    const custom = knowledge.topics.find((topic) => topic.fullId === "aa-custom/volume");
    expect(custom?.bankItems).toHaveLength(1);

    const catalog = createTopicCatalog(knowledge);
    const questions = buildRound("1", { answers: { grade: "Décimo" }, catalog });
    const topic = questions.find((question) => question.id === "topic");
    expect(topic?.options.map((option) => option.value)).toContain("aa-custom/volume");

    await h.run("new");
    const askedTopic = h.asked[1]?.questions.find((question) => question.id === "topic");
    expect(askedTopic?.options.map((option) => option.value)).toContain("aa-custom/volume");
  });
});
