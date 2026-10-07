import type { Rng } from "../math/rng.js";

export interface OptionCandidate {
  value: string;
  display: string;
  error: string;
}

/**
 * Places the correct option and up to three distinct distractors in seeded positions A-D.
 * Throws when fewer than four distinct canonical values are available (a generator bug).
 */
export function assembleOptions(
  rng: Rng,
  correct: OptionCandidate,
  distractors: readonly OptionCandidate[],
): Array<{ key: string; value: string; display: string; correct: boolean; error: string }> {
  const unique = new Map<string, OptionCandidate>([[correct.value, correct]]);
  for (const candidate of distractors) {
    if (unique.size >= 4) break;
    if (!unique.has(candidate.value)) unique.set(candidate.value, candidate);
  }
  if (unique.size < 4) {
    throw new Error(`Not enough distinct options for an item (${unique.size} of 4)`);
  }
  const keys = ["A", "B", "C", "D"];
  return rng.shuffle([...unique.values()]).map((candidate, index) => ({
    key: keys[index] ?? "?",
    value: candidate.value,
    display: candidate.display,
    correct: candidate === correct,
    error: candidate.error,
  }));
}
