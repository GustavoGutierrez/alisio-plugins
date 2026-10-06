import { type Level, type PhaseOptions, phasesForLevel } from "./levels.js";

export const phases = [
  "intake",
  "context",
  "specify",
  "ui-contract",
  "tokens",
  "plan",
  "test-design",
  "build",
  "validate",
  "review",
  "accept",
  "archive",
  "closed",
] as const;
export type Phase = (typeof phases)[number];

export const isPhase = (value: unknown): value is Phase =>
  typeof value === "string" && (phases as readonly string[]).includes(value);

/** The phase after `current` for a level, or `undefined` when `current` is last or not part of it. */
export function nextPhase(
  level: Level,
  current: Phase,
  options: PhaseOptions = {},
): Phase | undefined {
  const list = phasesForLevel(level, options);
  const index = list.indexOf(current);
  return index === -1 ? undefined : list[index + 1];
}
