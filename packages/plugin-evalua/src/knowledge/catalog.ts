import type { TopicCatalog } from "../types.js";
import { type LoadedKnowledge, localized } from "./types.js";

/**
 * Adapts a loaded knowledge base to the interview's `TopicCatalog` seam: pack and topic
 * choices are read from data, never hard-coded (spec 6.1, 6.6).
 */
export function createTopicCatalog(knowledge: LoadedKnowledge): TopicCatalog {
  const topics = knowledge.topics;
  const packs = knowledge.packs.filter((pack) => pack.topics.length > 0);
  const byFullId = new Map(topics.map((topic) => [topic.fullId, topic]));
  const bareCount = new Map<string, number>();
  for (const topic of topics) {
    bareCount.set(topic.id, (bareCount.get(topic.id) ?? 0) + 1);
  }
  return {
    packs: () => packs.map((pack) => ({ value: pack.id, label: localized(pack.name) })),
    suggestions: (grade) => {
      const filtered =
        grade === undefined ? topics : topics.filter((topic) => topic.grades.includes(grade));
      return filtered.map((topic) => ({ value: topic.fullId, label: localized(topic.name) }));
    },
    resolvePack: (topic) => {
      const direct = byFullId.get(topic);
      if (direct !== undefined) return direct.packId;
      if (bareCount.get(topic) === 1) {
        const found = topics.find((entry) => entry.id === topic);
        if (found !== undefined) return found.packId;
      }
      const needle = topic.trim().toLowerCase();
      const matches = topics.filter(
        (entry) =>
          localized(entry.name).toLowerCase() === needle ||
          entry.keywords.some((keyword) => keyword.toLowerCase() === needle),
      );
      return matches.length === 1 ? matches[0]?.packId : undefined;
    },
  };
}
