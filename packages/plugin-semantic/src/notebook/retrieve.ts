// Hybrid retrieval (D9): vector top 20 + FTS5 BM25 top 20, fused with Reciprocal Rank Fusion.

export const RRF_K = 60;
export const RETRIEVE_EACH = 20;
export const RETRIEVE_KEEP = 8;

/**
 * Sum of `1 / (k + rank)` over the lists an id appears in (1-based rank, first occurrence per
 * list). Ties keep first-seen order (list order, then rank), so the fusion is deterministic.
 */
export function reciprocalRankFusion(
  lists: string[][],
  options: { k?: number; top?: number } = {},
): string[] {
  const k = options.k ?? RRF_K;
  const scores = new Map<string, { score: number; seen: number }>();
  let seen = 0;
  for (const list of lists) {
    const counted = new Set<string>();
    list.forEach((id, index) => {
      if (counted.has(id)) return;
      counted.add(id);
      const entry = scores.get(id) ?? { score: 0, seen: seen++ };
      entry.score += 1 / (k + index + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].seen - b[1].seen)
    .slice(0, options.top ?? RETRIEVE_KEEP)
    .map(([id]) => id);
}

/** A safe FTS5 MATCH expression: every word quoted, joined by OR (operators become words). */
export function ftsQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 64)
    .map((word) => `"${word}"`)
    .join(" OR ");
}
