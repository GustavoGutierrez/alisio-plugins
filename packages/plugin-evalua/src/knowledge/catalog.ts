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
    resolveTopic: (text) => {
      const clean = text.trim();
      if (clean === "") return undefined;
      const direct = byFullId.get(clean);
      if (direct !== undefined) return direct.fullId;
      if (bareCount.get(clean) === 1) {
        const found = topics.find((entry) => entry.id === clean);
        if (found !== undefined) return found.fullId;
      }
      const needle = clean.toLowerCase();
      const needleWords = [...new Set(needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
      const matchesWord = (a: string, b: string): boolean => {
        if (a === b) return true;
        const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
        return shorter.length >= 5 && longer.startsWith(shorter);
      };
      const scored = topics
        .map((entry) => {
          const labelWords = localized(entry.name)
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean);
          let score = 0;
          for (const word of needleWords) {
            if (labelWords.some((label) => matchesWord(label, word))) score += 1;
          }
          for (const keyword of entry.keywords) {
            const key = keyword.toLowerCase();
            if (needle === key) score += 3;
            else if (key.includes(" ") && needle.includes(key)) score += 3;
            else if (needleWords.length <= 3 && needleWords.includes(key)) score += 2;
          }
          return { fullId: entry.fullId, score };
        })
        .filter((entry) => entry.score >= 2)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best === undefined) return undefined;
      const tie = scored.filter((entry) => entry.score === best.score);
      return tie.length === 1 ? best.fullId : undefined;
    },
  };
}
