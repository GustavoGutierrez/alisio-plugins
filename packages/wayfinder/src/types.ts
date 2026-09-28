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
  changedPaths?: string[];
  evidence?: CommandEvidence[];
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
  verification?: VerificationSummary;
}

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
  notes: string[];
}

export interface VerificationOutput {
  schemaVersion: 1;
  passed: boolean;
  summary: string;
  requirements: Array<{ id: string; status: "passed" | "failed"; evidence: string[] }>;
  checks: CommandEvidence[];
  blockers: string[];
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
