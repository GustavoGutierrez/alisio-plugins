import { beforeAll, describe, expect, it } from "vitest";
import { families, familyIds } from "../../src/families/index.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LoadedKnowledge, LoadedPack } from "../../src/knowledge/types.js";
import { createRng } from "../../src/math/rng.js";
import { levels as allLevels } from "../../src/types.js";
import { verifyDraft } from "../../src/verify.js";

const FAMILY_PACKS: ReadonlyArray<{ id: string; pack: string }> = [
  { id: "add-subtract", pack: "primary-math" },
  { id: "multiplication", pack: "primary-math" },
  { id: "division", pack: "primary-math" },
  { id: "measurement", pack: "primary-math" },
  { id: "statistics", pack: "basic-math" },
];

let knowledge: LoadedKnowledge;
let packs: Map<string, LoadedPack>;

beforeAll(async () => {
  knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  packs = new Map(knowledge.packs.map((pack) => [pack.id, pack]));
});

describe("new item families", () => {
  it("loads the shipped knowledge base without findings", () => {
    expect(knowledge.report.results).toEqual([]);
  });
});

describe.each(FAMILY_PACKS)("$id", ({ id, pack: packId }) => {
  it.each(allLevels)(
    "level %s: the answer verifies, solve agrees and the options are distinct",
    (level) => {
      const family = families[id];
      const limits = packs.get(packId)?.levels[level];
      if (!family || !limits) throw new Error(`missing family or calibration for ${id}/${level}`);
      for (let seed = 0; seed < 40; seed += 1) {
        const context = `${id}/${level}/${seed}`;
        const draft = family.generate({
          rng: createRng(`${id}-${level}-${seed}`),
          level,
          calibration: limits,
        });
        expect(draft.family, context).toBe(id);
        expect(draft.type, context).toBe("single_choice");
        expect(verifyDraft(draft, family, level, limits), context).toEqual([]);
        expect(draft.answer.canonical, context).toBe(String(family.solve(draft.problem)));
        expect(draft.options, context).toHaveLength(4);
        expect(
          draft.options.filter((option) => option.correct),
          context,
        ).toHaveLength(1);
        const values = draft.options.map((option) => option.value);
        expect(new Set(values).size, context).toBe(4);
        expect(draft.solution.length, context).toBe(draft.stepCount);
      }
    },
  );
});

describe("MEN pensamiento coverage", () => {
  it("ships the primary-math pack with its topics and grades", () => {
    const pack = packs.get("primary-math");
    expect(pack?.name.es).toBe("Matemática primaria");
    const whole = pack?.topics.find((topic) => topic.id === "whole-number-operations");
    expect(whole?.grades).toEqual(["Primero", "Segundo", "Tercero", "Cuarto", "Quinto"]);
    expect(
      whole?.sources.flatMap((source) => (source.kind === "family" ? [source.family] : [])).sort(),
    ).toEqual(["add-subtract", "division", "multiplication"]);
    const measure = pack?.topics.find((topic) => topic.id === "measurement");
    expect(measure?.grades).toEqual(["Tercero", "Cuarto", "Quinto"]);
    expect(measure?.prerequisites).toEqual(["whole-number-operations"]);
  });

  it("adds the statistics topic to basic-math", () => {
    const stats = packs.get("basic-math")?.topics.find((topic) => topic.id === "statistics");
    expect(stats?.grades).toEqual(["Sexto", "Séptimo", "Octavo", "Noveno"]);
    expect(stats?.sources).toContainEqual({
      kind: "family",
      family: "statistics",
      levels: ["basico", "intermedio", "avanzado", "genio"],
    });
  });
});
