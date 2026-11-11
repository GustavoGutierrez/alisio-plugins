import { beforeAll, describe, expect, it } from "vitest";
import { families, familyIds } from "../../src/families/index.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";
import type { LevelCalibration } from "../../src/knowledge/types.js";
import { createRng } from "../../src/math/rng.js";
import { levels as allLevels } from "../../src/types.js";

/**
 * Each family is checked against the calibration of every shipped pack whose topics use it (a
 * family no topic uses yet is checked against basic-math), so a primary-school family is held to
 * the primary-math number ranges it is actually generated with.
 */
let calibrations: Map<string, Array<{ pack: string; levels: Record<string, LevelCalibration> }>>;

beforeAll(async () => {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  const basic = knowledge.packs.find((entry) => entry.id === "basic-math");
  if (!basic) throw new Error("basic-math pack missing");
  calibrations = new Map();
  for (const id of familyIds) {
    const packs = knowledge.packs.filter((pack) =>
      pack.topics.some((topic) =>
        topic.sources.some((source) => source.kind === "family" && source.family === id),
      ),
    );
    calibrations.set(
      id,
      (packs.length > 0 ? packs : [basic]).map((pack) => ({ pack: pack.id, levels: pack.levels })),
    );
  }
});

describe.each(familyIds)("%s", (id) => {
  const family = families[id];

  it.each(allLevels)(
    "level %s: the answer verifies, distractors are distinct and the calibration is respected",
    (level) => {
      for (const { pack, levels } of calibrations.get(id) ?? []) {
        const limits = levels[level];
        if (!family || !limits) throw new Error(`missing family or calibration for ${id}/${level}`);
        for (let seed = 0; seed < 30; seed += 1) {
          const context = `${id}/${pack}/${level}/${seed}`;
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
      }
    },
  );
});
