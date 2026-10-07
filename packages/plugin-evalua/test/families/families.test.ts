import { beforeAll, describe, expect, it } from "vitest";
import { families, familyIds } from "../../src/families/index.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LevelCalibration } from "../../src/knowledge/types.js";
import { createRng } from "../../src/math/rng.js";
import { levels as allLevels } from "../../src/types.js";

let calibration: Record<string, LevelCalibration>;

beforeAll(async () => {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  const pack = knowledge.packs.find((entry) => entry.id === "basic-math");
  if (!pack) throw new Error("basic-math pack missing");
  calibration = pack.levels;
});

describe.each(familyIds)("%s", (id) => {
  const family = families[id];

  it.each(allLevels)(
    "level %s: the answer verifies, distractors are distinct and the calibration is respected",
    (level) => {
      const limits = calibration[level];
      if (!family || !limits) throw new Error(`missing family or calibration for ${id}/${level}`);
      for (let seed = 0; seed < 30; seed += 1) {
        const context = `${id}/${level}/${seed}`;
        const draft = family.generate({
          rng: createRng(`${id}-${level}-${seed}`),
          level,
          calibration: limits,
        });
        expect(draft.answer.canonical, context).toBe(String(family.solve(draft.problem)));
        expect(draft.options, context).toHaveLength(4);
        const values = draft.options.map((option) => option.value);
        expect(new Set(values).size, context).toBe(4);
        expect(
          draft.options.filter((option) => option.correct),
          context,
        ).toHaveLength(1);
        expect(draft.solution.length, context).toBe(draft.stepCount);
        expect(draft.solution.length, context).toBeGreaterThanOrEqual(limits.steps[0]);
        expect(draft.solution.length, context).toBeLessThanOrEqual(limits.steps[1]);
        for (const value of draft.numericValues) {
          expect(value, context).toBeGreaterThanOrEqual(limits.coefficientRange[0]);
          expect(value, context).toBeLessThanOrEqual(limits.coefficientRange[1]);
        }
      }
    },
  );
});
