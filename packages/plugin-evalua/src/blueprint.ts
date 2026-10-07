import type { LevelCalibration } from "./knowledge/types.js";
import { type Cognitive, type ItemType, itemTypes, type Level } from "./types.js";

export interface BlueprintCell {
  topic: string;
  cognitive: Cognitive;
  type: ItemType;
  count: number;
}

/** The exam blueprint: topic x cognitive demand x item type, counts summing to the total (spec 8.1). */
export interface Blueprint {
  schemaVersion: 1;
  level: Level;
  total: number;
  cells: BlueprintCell[];
}

const cognitiveOrder: readonly Cognitive[] = ["recall", "apply", "reason"];

/** Largest-remainder apportionment of `total` across `weights`; ties break by index. */
export function distribute(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const base = exact.map((value) => Math.floor(value));
  let left = total - base.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of order) {
    if (left <= 0) break;
    base[entry.index] = (base[entry.index] ?? 0) + 1;
    left -= 1;
  }
  return base;
}

export interface BlueprintInput {
  topics: readonly string[];
  level: Level;
  calibration: LevelCalibration;
  itemTypes: Record<ItemType, number>;
}

/** Builds the blueprint by code from the topics, the level mix and the requested type counts. */
export function buildBlueprint(input: BlueprintInput): Blueprint {
  const mix = input.calibration.cognitiveMix;
  const mixWeights = [mix.recall, mix.apply, mix.reason];
  const cells: BlueprintCell[] = [];
  for (const type of itemTypes) {
    const total = input.itemTypes[type] ?? 0;
    if (total <= 0) continue;
    const perTopic = distribute(
      total,
      input.topics.map(() => 1),
    );
    input.topics.forEach((topic, topicIndex) => {
      const topicCount = perTopic[topicIndex] ?? 0;
      if (topicCount <= 0) return;
      const perCognitive = distribute(topicCount, mixWeights);
      cognitiveOrder.forEach((cognitive, cognitiveIndex) => {
        const count = perCognitive[cognitiveIndex] ?? 0;
        if (count > 0) cells.push({ topic, cognitive, type, count });
      });
    });
  }
  return {
    schemaVersion: 1,
    level: input.level,
    total: cells.reduce((acc, cell) => acc + cell.count, 0),
    cells,
  };
}

export function blueprintTotal(blueprint: Blueprint): number {
  return blueprint.cells.reduce((acc, cell) => acc + cell.count, 0);
}
