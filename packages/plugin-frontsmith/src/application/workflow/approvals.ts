import type { FeatureState, GateId } from "../../domain/state/feature-state.js";
import { type ApprovalKind, approvalsForLevel } from "../../domain/state/levels.js";
import { type Phase, phases } from "../../domain/state/phases.js";

/** Approval targets of `/frontsmith:approve` (spec 7.4, B-08). */
export const approvalTargets = [
  "spec",
  "ui-contract",
  "plan",
  "acceptance",
  "config",
  "review-signoff",
  "dependency",
] as const;
export type ApprovalTarget = (typeof approvalTargets)[number];

/**
 * Targets of `/frontsmith:reject`: a failed review sign-off is a G8 remediation, not a rejection.
 * TODO(owner): B-08 `review-signoff` is an approve target only (W-13).
 */
export const rejectTargets = ["spec", "ui-contract", "plan", "acceptance"] as const;
export type RejectTarget = (typeof rejectTargets)[number];

export const parseApprovalTarget = (text: string): ApprovalTarget | undefined =>
  (approvalTargets as readonly string[]).includes(text) ? (text as ApprovalTarget) : undefined;
export const parseRejectTarget = (text: string): RejectTarget | undefined =>
  (rejectTargets as readonly string[]).includes(text) ? (text as RejectTarget) : undefined;

export const approvalCommand = (feature: string, target: ApprovalTarget, name?: string): string =>
  `/frontsmith:approve ${feature} ${target}${name ? ` ${name}` : ""}`;
export const rejectCommand = (feature: string, target: RejectTarget): string =>
  `/frontsmith:reject ${feature} ${target} -- <comments>`;

/** The gate that follows a phase (spec 7.2); phases without one run no gate of their own. */
const PHASE_GATE: Partial<Record<Phase, GateId>> = {
  context: "G0",
  specify: "G1",
  "ui-contract": "G2",
  tokens: "G2T",
  plan: "G3",
  "test-design": "G4",
  validate: "G7",
  review: "G8",
  accept: "G9",
};
export const gateOfPhase = (phase: Phase): GateId | undefined => PHASE_GATE[phase];

const PHASE_APPROVAL: Partial<Record<Phase, ApprovalKind>> = {
  specify: "spec",
  "ui-contract": "ui-contract",
  plan: "plan",
  review: "review-signoff",
  accept: "acceptance",
};

const SLOT: Record<ApprovalKind, "spec" | "uiContract" | "plan" | "acceptance" | "reviewSignoff"> =
  {
    spec: "spec",
    "ui-contract": "uiContract",
    plan: "plan",
    acceptance: "acceptance",
    "review-signoff": "reviewSignoff",
  };

/** The approval a person still owes before the feature can leave `phase`, or `undefined`. */
export function approvalToLeave(state: FeatureState, phase: Phase): ApprovalKind | undefined {
  const needed = PHASE_APPROVAL[phase];
  if (!needed || !approvalsForLevel(state.level).includes(needed)) return undefined;
  return state.approvals[SLOT[needed]] ? undefined : needed;
}

export interface ApplyApprovalInput {
  now: string;
  note?: string;
  /** Path -> sha256 of the approved oracles; they become the protected set (spec 8.5). */
  hashes?: Record<string, string>;
  /** Dependency name for the `dependency` target. */
  name?: string;
}

/** Record an approval on a draft state (a human decision: the caller proves it came from a command). */
export function applyApproval(
  draft: FeatureState,
  target: ApprovalTarget,
  input: ApplyApprovalInput,
): void {
  const approval = {
    at: input.now,
    by: "human" as const,
    ...(input.note ? { note: input.note } : {}),
    ...(input.hashes ? { hashes: input.hashes } : {}),
  };
  if (target === "dependency") {
    if (input.name) draft.approvals.dependencies[input.name] = approval;
    return;
  }
  if (target === "config") return; // re-baselining is done by the caller against the files
  draft.approvals[SLOT[target]] = approval;
  if (input.hashes) Object.assign(draft.protected, input.hashes);
}

const PRODUCER: Record<RejectTarget, Phase> = {
  spec: "specify",
  "ui-contract": "ui-contract",
  plan: "plan",
  // TODO(owner): spec 7.4 says "returns to the producing phase"; acceptance has none, so it returns
  // to build where the comments become a remediation task (documented in the status text).
  acceptance: "build",
};

const MAX_FEEDBACK = 4000;

/**
 * Reject an approval: drop it, go back to the producing phase, forget the gates of that phase and
 * of every later phase, and keep the comments for the next prompt of the producing phase.
 */
export function applyRejection(draft: FeatureState, target: RejectTarget, comments: string): Phase {
  const slot = SLOT[target];
  delete draft.approvals[slot];
  const phase = PRODUCER[target];
  draft.phase = phase;
  const from = phases.indexOf(phase);
  const gates = draft.gates;
  for (const [id] of Object.entries(gates)) {
    const owner = (Object.entries(PHASE_GATE) as Array<[Phase, GateId]>).find(
      ([, gate]) => gate === id,
    )?.[0];
    if (owner !== undefined && phases.indexOf(owner) >= from) delete gates[id as GateId];
  }
  if (phase === "build") delete gates.G6;
  delete draft.blocked;
  const feedback = draft.feedback ?? {};
  draft.feedback = feedback;
  const list = feedback[target] ?? [];
  feedback[target] = list;
  list.push(comments.slice(0, MAX_FEEDBACK));
  return phase;
}
