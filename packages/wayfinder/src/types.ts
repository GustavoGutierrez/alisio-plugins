export const phases = [
  "discovery",
  "proposal",
  "proposal-approval",
  "specification",
  "design",
  "plan",
  "plan-approval",
  "implementation",
  "verification",
  "archive",
  "closed",
] as const;
export type Phase = (typeof phases)[number];

export const executionRoles = [
  "discoverer",
  "proposer",
  "specifier",
  "designer",
  "planner",
  "implementer",
  "verifier",
  "mutationist",
  "archivist",
] as const;
export type ExecutionRole = (typeof executionRoles)[number];
export type ResourceRole = "coordinator" | ExecutionRole;

export interface CommandEvidence {
  command: string;
  status: "passed";
  summary: string;
}

export interface WorkUnit {
  id: string;
  title: string;
  goal: string;
  requirements: string[];
  paths: string[];
  checks: string[];
  status: "pending" | "completed";
  /** Optional unit intent; absent means a normal implementation unit. */
  kind?: "implementation" | "test-strengthening";
  /** When true, strict TDD does not require test-first evidence; a justification is mandatory. */
  tddExempt?: boolean;
  tddExemptReason?: string;
  /** When true, the unit must report test-design evidence (happy and unhappy coverage). */
  requiresTests?: boolean;
  changedPaths?: string[];
  evidence?: CommandEvidence[];
}

export type MutationStack = "javascript" | "rust" | "python" | "go" | "java" | "unknown";
export type MutationScopeMode = "changed" | "full";
export type MutationDecisionValue = "run" | "skip";
/** `paths` can honor a bounded file scope; `none` can only run whole-repository. */
export type MutationScopeSupport = "paths" | "none";
/** Whether the coordinator's concurrency bound is actually passed to the tool. */
export type MutationConcurrency = "applied" | "unsupported";

export type TddDecisionValue = "strict" | "off";

export interface TddState {
  decision: TddDecisionValue;
  reason: string;
  decidedAt: string;
  source: "recommended" | "manual";
}

export interface MutationDecision {
  decision: MutationDecisionValue;
  mode: MutationScopeMode;
  reason: string;
  decidedAt: string;
  stack: MutationStack;
  source: "recommended" | "manual";
  tool?: string;
}

export interface MutationSurvivor {
  file: string;
  line?: number;
  description: string;
  equivalent: boolean;
  justification: string;
}

export interface MutationRun {
  tool: string;
  stack: MutationStack;
  mode: MutationScopeMode;
  /** Optional for additive compatibility; written on every new run. */
  scopeSupport?: MutationScopeSupport;
  concurrencyApplied?: boolean;
  scope: string[];
  command: string;
  survivors: MutationSurvivor[];
  failingSurvivors: number;
  equivalentSurvivors: number;
  mutationScore?: number;
  summary: string;
  ranAt: string;
  truncated?: boolean;
  unavailableReason?: string;
}

export interface MutationTarget {
  files: string[];
  requirementIds: string[];
  attempt: number;
}

export interface MutationState {
  decision?: MutationDecision;
  run?: MutationRun;
  targeted?: MutationTarget;
}

export interface VerificationSummary {
  passed: boolean;
  summary: string;
  blockers: string[];
  checkedAt: string;
}

export interface ChangeState {
  schemaVersion: 2;
  name: string;
  intent: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  proposalApproved: boolean;
  planApproved: boolean;
  requirementIds: string[];
  units: WorkUnit[];
  remediationCount: number;
  /** Optional for additive compatibility; absent legacy states normalize to 0 on load. */
  mutationRemediationCount?: number;
  mutation?: MutationState;
  /** Optional test-first decision; absent means the plan-approval gate is still pending. */
  tdd?: TddState;
  verification?: VerificationSummary;
}

/**
 * A `ChangeState` produced by `readState`: additively optional fields are normalized, so runtime
 * logic always reads `mutationRemediationCount` as a number.
 */
export type NormalizedChangeState = ChangeState & { mutationRemediationCount: number };

export interface DiscoveryOutput {
  schemaVersion: 1;
  summary: string;
  findings: string[];
  constraints: string[];
  criticalQuestions: string[];
}

export interface ProposalOutput {
  schemaVersion: 1;
  outcome: string;
  inScope: string[];
  outOfScope: string[];
  assumptions: string[];
  criticalQuestions: string[];
}

export interface Requirement {
  id: string;
  statement: string;
  acceptance: string[];
}

export interface SpecificationOutput {
  schemaVersion: 1;
  requirements: Requirement[];
  criticalQuestions: string[];
}

export interface DesignOutput {
  schemaVersion: 1;
  summary: string;
  decisions: Array<{ topic: string; choice: string; rationale: string }>;
  paths: string[];
  risks: string[];
}

export interface PlanOutput {
  schemaVersion: 1;
  units: Array<Omit<WorkUnit, "status" | "changedPaths" | "evidence">>;
}

export interface ImplementationOutput {
  schemaVersion: 1;
  unitId: string;
  summary: string;
  changedPaths: string[];
  checks: CommandEvidence[];
  testFirst?: {
    failingCommand: string;
    passingCommand: string;
    failingEvidenceRef?: string;
  };
  testDesign?: TestDesignEntry[];
  testability?: Testability;
  notes: string[];
}

/** Positive (happy) and negative (unhappy/alternative) tests observed for one functional scenario. */
export interface TestDesignEntry {
  scenario: string;
  happy: string[];
  unhappy: string[];
}

/** UI test-selector evidence: semantic ids, or a reason that only accessibility queries are used. */
export interface Testability {
  testIds: string[];
  accessibleOnlyReason?: string;
}

export interface VerificationOutput {
  schemaVersion: 1;
  passed: boolean;
  summary: string;
  requirements: Array<{ id: string; status: "passed" | "failed"; evidence: string[] }>;
  checks: CommandEvidence[];
  blockers: string[];
}

export interface MutationOutput {
  schemaVersion: 1;
  tool: string;
  stack: string;
  survivors: MutationSurvivor[];
  mutationScore?: number;
  summary: string;
}

export interface ArchiveOutput {
  schemaVersion: 1;
  ready: boolean;
  artifacts: string[];
  completedUnits: string[];
  requirements: string[];
  blockers: string[];
  summary: string;
}
