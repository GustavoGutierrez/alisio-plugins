// Structured read models of Thesis Studio (D10). Lifecycle decisions are never re-implemented:
// the next step is the coordinator's own `/thesis:...` recommendation, mapped to an app action.
import { defaultRounds, presentationRound } from "../intake.js";
import type { Phase, ThesisState } from "../types.js";

export interface NextStep {
  /** App action (or a frame-only "interview", "findings", "wait", "done"). */
  action: string;
  target?: string;
  phase: Phase | null;
  /** Key of the frame's one-sentence "why". */
  reasonKey: string;
}

export interface SectionStep {
  action: string;
  target?: string;
  waitsFor?: string[];
}

const COMMAND = /^\/thesis:([a-z]+)(?:\s+(\S+))?/;

/** Maps one `/thesis:...` recommendation (Workflow.nextCommand) to an app step. */
export function commandToStep(command: string, state: ThesisState): NextStep {
  const phase = state.phase;
  const match = COMMAND.exec(command);
  const name = match?.[1] ?? "";
  const target = match?.[2];
  switch (name) {
    case "answer":
      return { action: "interview", phase, reasonKey: "answer_questions" };
    case "design":
      return { action: "design.run", phase, reasonKey: "draft_protocol" };
    case "outline":
      return { action: "outline.run", phase, reasonKey: "draft_outline" };
    case "approve": {
      const reasonKey =
        target === "A"
          ? "approve_gate_a"
          : target === "B"
            ? "approve_gate_b"
            : target === "OUTLINE"
              ? "approve_outline"
              : state.sections[target ?? ""]?.status === "research_review"
                ? "approve_research"
                : "approve_draft";
      return { action: "approve", ...(target ? { target } : {}), phase, reasonKey };
    }
    case "draft":
      return {
        action: "draft.run",
        ...(target ? { target } : {}),
        phase,
        reasonKey: "write_draft",
      };
    case "research":
      return {
        action: "research.run",
        ...(target ? { target } : {}),
        phase,
        reasonKey: "research_section",
      };
    case "review":
      return { action: "review.run", target: target ?? "all", phase, reasonKey: "run_review" };
    case "revise":
      return { action: "findings", phase, reasonKey: "fix_findings" };
    case "finalize":
      return { action: "finalize.run", phase, reasonKey: "finalize" };
    default:
      return phase === "submitted"
        ? { action: "done", phase, reasonKey: "submitted" }
        : { action: "wait", phase, reasonKey: "waiting_dependencies" };
  }
}

/**
 * The guided "Next step" (spec §6.2): the same decisions as `/thesis:status` ("Next: ..."), so
 * the app and the chat never disagree. `nextCommand` is `Workflow.nextCommand` for that state.
 */
export function nextStep(
  state: ThesisState | undefined,
  nextCommand: (state: ThesisState) => string,
): NextStep {
  if (!state) return { action: "project.init", phase: null, reasonKey: "start" };
  if (state.pendingQuestions)
    return { action: "interview", phase: state.phase, reasonKey: "answer_questions" };
  if (!defaultRounds.every((round) => state.intake.completedRounds.includes(round)))
    return { action: "project.init", phase: state.phase, reasonKey: "finish_interview" };
  if (state.phase === "intake")
    return { action: "check.run", phase: state.phase, reasonKey: "fix_g0" };
  return commandToStep(nextCommand(state), state);
}

/** One section's next step from `Workflow.sectionNext` text ("/thesis:draft SEC-03", "waits for ..."). */
export function sectionStep(text: string, state: ThesisState): SectionStep | null {
  if (!text) return null;
  const waits = /^waits for (.+)$/.exec(text);
  if (waits)
    return {
      action: "wait",
      waitsFor: (waits[1] as string)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^SEC-/.test(part)),
    };
  const step = commandToStep(text, state);
  return { action: step.action, ...(step.target ? { target: step.target } : {}) };
}

/** True when the optional presentation round may be offered (after rounds 1 and 2). */
export const presentationOpen = (state: ThesisState): boolean =>
  [1, 2].every((round) => state.intake.completedRounds.includes(round)) &&
  !state.intake.completedRounds.includes(presentationRound) &&
  !state.pendingQuestions;
