import type { Phase } from "./phases.js";

/** Rigor levels L0-L3 select phases and human approvals (spec 7.1). */
export const levels = ["L0", "L1", "L2", "L3"] as const;
export type Level = (typeof levels)[number];

export const isLevel = (value: unknown): value is Level =>
  typeof value === "string" && (levels as readonly string[]).includes(value);

export interface PhaseOptions {
  /** The ui-contract declares new tokens, or no token system was detected. Only L2 and L3 care. */
  tokensNeeded?: boolean;
}

export type ApprovalKind = "spec" | "ui-contract" | "plan" | "acceptance" | "review-signoff";

const L0: readonly Phase[] = ["intake", "context", "build", "validate", "review", "closed"];
const L1: readonly Phase[] = [
  "intake",
  "context",
  "specify",
  "plan",
  "build",
  "validate",
  "review",
  "closed",
];
const FULL: readonly Phase[] = [
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
];

export function phasesForLevel(level: Level, options: PhaseOptions = {}): Phase[] {
  if (level === "L0") return [...L0];
  if (level === "L1") return [...L1];
  return FULL.filter((phase) => phase !== "tokens" || options.tokensNeeded === true);
}

export function approvalsForLevel(level: Level): ApprovalKind[] {
  if (level === "L0") return [];
  if (level === "L1") return ["spec"];
  const base: ApprovalKind[] = ["spec", "ui-contract", "plan", "acceptance"];
  return level === "L3" ? [...base, "review-signoff"] : base;
}

export interface LevelRequirements {
  adrRequired: boolean;
  securityRiskRequired: boolean;
  reviewRuns: number;
  a11yAuditMandatory: boolean;
}

export function requirementsForLevel(level: Level): LevelRequirements {
  const high = level === "L3";
  return {
    adrRequired: high,
    securityRiskRequired: high,
    reviewRuns: high ? 2 : 1,
    a11yAuditMandatory: high,
  };
}
