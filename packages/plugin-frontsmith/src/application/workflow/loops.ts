/**
 * Loop bounds of spec 7.3 as pure decisions. Every loop has a counter and a terminal state; none
 * ends in tacit acceptance (spec 2.3).
 */

export type BounceDecision =
  | { action: "bounce"; attempt: number }
  | { action: "blocked"; reason: string };

/** G6 FAIL: bounce the task to the same child up to `max` times, then block it. */
export function bounceDecision(input: { bounces: number; max: number }): BounceDecision {
  if (input.bounces >= input.max)
    return { action: "blocked", reason: `bounce limit of ${input.max} reached` };
  return { action: "bounce", attempt: input.bounces + 1 };
}

export type RepairDecision =
  | { action: "done" }
  | { action: "repair"; round: number }
  | { action: "stop"; reason: "no-improvement" | "exhausted"; message: string };

/**
 * G7 FAIL: repair while the number of failing findings strictly decreases from one round to the
 * next. A round that does not improve stops at once; reaching `max` rounds with failures left stops
 * as exhausted. In both cases the feature is BLOCKED with the reports kept.
 */
export function repairDecision(input: {
  round: number;
  max: number;
  previousFailures: number | undefined;
  failures: number;
}): RepairDecision {
  if (input.failures === 0) return { action: "done" };
  if (input.previousFailures !== undefined && input.failures >= input.previousFailures)
    return {
      action: "stop",
      reason: "no-improvement",
      message: `repair round ${input.round} did not reduce the failures (${input.previousFailures} before, ${input.failures} after)`,
    };
  if (input.round >= input.max)
    return {
      action: "stop",
      reason: "exhausted",
      message: `${input.failures} failure${input.failures === 1 ? "" : "s"} left after ${input.max} repair round${input.max === 1 ? "" : "s"}`,
    };
  return { action: "repair", round: input.round + 1 };
}

export type RemediationDecision =
  | { action: "done" }
  | { action: "remediate"; round: number }
  | { action: "stop"; message: string };

/** G8 BLOCKER or MAJOR: findings become tasks, up to `max` remediation rounds. */
export function remediationDecision(input: {
  remediations: number;
  max: number;
  open: number;
}): RemediationDecision {
  if (input.open === 0) return { action: "done" };
  if (input.remediations >= input.max)
    return {
      action: "stop",
      message: `${input.open} blocker or major finding${input.open === 1 ? "" : "s"} open after ${input.max} remediation round${input.max === 1 ? "" : "s"}`,
    };
  return { action: "remediate", round: input.remediations + 1 };
}

export interface FindingGroup {
  file: string | undefined;
  findingIds: string[];
}

/** Repair tasks group findings by file in stable order; findings without a file form the last group. */
export function groupFindingsByFile(
  findings: ReadonlyArray<{ id: string; file?: string }>,
): FindingGroup[] {
  const byFile = new Map<string | undefined, string[]>();
  for (const finding of [...findings].sort((a, b) => a.id.localeCompare(b.id))) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding.id);
    byFile.set(finding.file, list);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => (a === undefined ? 1 : b === undefined ? -1 : a.localeCompare(b)))
    .map(([file, findingIds]) => ({ file, findingIds }));
}
