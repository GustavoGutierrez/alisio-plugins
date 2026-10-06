import type { FeatureState, GateId } from "../../domain/state/feature-state.js";
import type { Phase } from "../../domain/state/phases.js";
import { approvalCommand, approvalToLeave, gateOfPhase } from "./approvals.js";

export interface NextAction {
  kind: "next" | "answer" | "approve" | "blocked" | "job" | "closed";
  /** The exact command a person runs next. */
  command: string;
  message: string;
}

const PASSING = new Set(["PASS", "REVIEW"]);

export const openBlockingQuestions = (state: FeatureState): FeatureState["questions"] =>
  state.questions.filter((q) => q.blocking && (q.answer === undefined || q.answer === ""));

/** Phases whose gate must hold before a person approves; the build phase has no phase gate. */
export function gateHolds(state: FeatureState, phase: Phase): boolean {
  const gate: GateId | undefined = gateOfPhase(phase);
  const entry = gate ? state.gates[gate] : undefined;
  if (!entry) return false;
  if (PASSING.has(entry.verdict)) return true;
  // A plan blocked only by dependencies waiting for approval is approved together with them.
  return (
    phase === "plan" &&
    entry.verdict === "BLOCKED" &&
    (entry.blockedChecks ?? []).every((id) => id === "new-dependencies") &&
    (entry.failedChecks ?? []).length === 0
  );
}

/**
 * What happens next for a feature, derived from its state alone (spec 7.4, 7.5): an open question,
 * an approval, a blocked unit or the next unit. Always an exact command.
 */
export function nextAction(state: FeatureState, jobAlive = false): NextAction {
  const f = state.feature;
  if (state.phase === "closed")
    return {
      kind: "closed",
      command: `/frontsmith:status ${f}`,
      message: "The feature is closed.",
    };
  if (state.job && jobAlive)
    return {
      kind: "job",
      command: `/frontsmith:status ${f}`,
      message: `Job ${state.job.id} is running the ${state.job.unit} unit.`,
    };
  const open = openBlockingQuestions(state)[0];
  if (open && state.phase === "specify" && state.artifacts["spec-json"])
    return {
      kind: "answer",
      command: `/frontsmith:answer ${f} ${open.id} -- <answer>`,
      message: `${open.id} blocks the spec: ${open.question}`,
    };
  if (state.blocked)
    return {
      kind: "blocked",
      command: `/frontsmith:next ${f}`,
      message: `${state.blocked.reason} Fix the cause, then run the unit again.`,
    };
  const owed = approvalToLeave(state, state.phase);
  if (owed && gateHolds(state, state.phase))
    return {
      kind: "approve",
      command: approvalCommand(f, owed),
      message: `Review the ${state.phase} artifacts, then approve ${owed}.`,
    };
  return {
    kind: "next",
    command: `/frontsmith:next ${f}`,
    message: `Run the ${state.phase} unit.`,
  };
}
