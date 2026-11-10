import { buildBlueprint } from "./blueprint.js";
import { generateExam } from "./generate.js";
import type { LevelCalibration, LoadedTopic, LocalizedText } from "./knowledge/types.js";
import { type ItemType, itemTypes, type Level } from "./types.js";

/** A topic x item type the knowledge base cannot fill with as many distinct questions as asked. */
export interface CapacityShortfall {
  topic: string;
  /** The topic's localized name, so a message can name it in plain words. */
  name: LocalizedText;
  type: ItemType;
  requested: number;
  /** Distinct questions the dry run could place (the fewest over every seed tried). */
  available: number;
}

export interface CapacityInput {
  topics: readonly string[];
  level: Level;
  calibration: LevelCalibration;
  itemTypes: Record<ItemType, number>;
  knowledge: readonly LoadedTopic[];
  /**
   * Generation seeds to dry-run. Pass the exam id the draft will get first: generation is seeded
   * by it, so that run is exact; extra seeds guard against a later number changing the draw.
   */
  seeds: readonly string[];
  prompts?: Record<string, string[]>;
}

/**
 * Dry-runs the same deterministic blueprint + generation the exam uses and reports every
 * topic x type that comes up short. Topics the knowledge base does not know are skipped: the
 * generation step reports those itself.
 */
export function capacityShortfalls(input: CapacityInput): CapacityShortfall[] {
  const byId = new Map(input.knowledge.map((topic) => [topic.fullId, topic]));
  const topics = input.topics.filter((id) => byId.has(id));
  if (topics.length === 0) return [];
  const blueprint = buildBlueprint({
    topics,
    level: input.level,
    calibration: input.calibration,
    itemTypes: input.itemTypes,
  });
  const requested = new Map<string, number>();
  for (const cell of blueprint.cells) {
    const key = `${cell.topic}|${cell.type}`;
    requested.set(key, (requested.get(key) ?? 0) + cell.count);
  }
  const available = new Map<string, number>();
  for (const seed of input.seeds) {
    const result = generateExam({
      blueprint,
      topics: input.knowledge,
      level: input.level,
      calibration: input.calibration,
      seed,
      ...(input.prompts === undefined ? {} : { prompts: input.prompts }),
    });
    const placed = new Map<string, number>();
    for (const item of result.items) {
      const key = `${item.topic}|${item.type}`;
      placed.set(key, (placed.get(key) ?? 0) + 1);
    }
    for (const key of requested.keys()) {
      const count = placed.get(key) ?? 0;
      available.set(key, Math.min(available.get(key) ?? count, count));
    }
  }
  const shortfalls: CapacityShortfall[] = [];
  for (const topic of topics) {
    for (const type of itemTypes) {
      const key = `${topic}|${type}`;
      const want = requested.get(key);
      if (want === undefined) continue;
      const have = available.get(key) ?? 0;
      if (have < want) {
        shortfalls.push({
          topic,
          name: { ...(byId.get(topic)?.name ?? {}) },
          type,
          requested: want,
          available: have,
        });
      }
    }
  }
  return shortfalls;
}

/** The slot findings of a blocked generation as shortfalls against the blueprint (EVL-ITM-009). */
export function shortfallsFromFindings(
  findings: readonly { id: string; subject: string; message: string }[],
  cells: readonly { topic: string; type: ItemType; count: number }[],
  knowledge: readonly LoadedTopic[],
): CapacityShortfall[] {
  const missing = new Map<string, number>();
  for (const finding of findings) {
    if (finding.id !== "EVL-ITM-009") continue;
    const [topic, type] = finding.subject.split(" ");
    if (topic === undefined || !(itemTypes as readonly string[]).includes(type ?? "")) continue;
    const key = `${topic}|${type}`;
    missing.set(key, (missing.get(key) ?? 0) + 1);
  }
  const out: CapacityShortfall[] = [];
  for (const [key, lost] of missing) {
    const [topic, type] = key.split("|") as [string, ItemType];
    const requested = cells
      .filter((cell) => cell.topic === topic && cell.type === type)
      .reduce((sum, cell) => sum + cell.count, 0);
    out.push({
      topic,
      name: { ...(knowledge.find((entry) => entry.fullId === topic)?.name ?? {}) },
      type,
      requested,
      available: Math.max(0, requested - lost),
    });
  }
  return out;
}

const typeWords: Record<ItemType, string> = {
  single_choice: "single-choice",
  multiple_choice: "multiple-choice",
  open: "open-answer",
  practice: "practice",
};

/** One plain sentence for the chat (the app localizes its own from the structured fields). */
export function shortfallText(shortfall: CapacityShortfall): string {
  const name = shortfall.name.es ?? Object.values(shortfall.name)[0] ?? shortfall.topic;
  const kind = typeWords[shortfall.type];
  return shortfall.available === 0
    ? `the topic "${name}" has no ${kind} questions at this level; choose other question types or another topic`
    : `the topic "${name}" has only ${shortfall.available} distinct ${kind} questions at this level (you asked for ${shortfall.requested}); lower the count or choose another topic`;
}
