import type { Evidence } from "../domain/envelope.js";
import type { StoredHandoff } from "../domain/handoff.js";

/** Prompts sent to role sessions. They carry task data only; the role's rules live in its agent file. */

export interface MergeNote {
  commit: string;
  status: "already" | "merged" | "conflict";
  files?: string[];
}

export interface RolePromptInput {
  project: string;
  role: string;
  task: string;
  taskId: string;
  items: StoredHandoff[];
  merges: MergeNote[];
}

export function rolePrompt(input: RolePromptInput): string {
  const lines = [
    `Project: ${input.project}`,
    `Role: ${input.role}`,
    `Task: ${input.task} (${input.taskId})`,
    "",
  ];
  for (const item of input.items) {
    lines.push(
      item.handoff.type === "note"
        ? "Task description:"
        : `Handoff from ${item.handoff.from} at commit ${item.handoff.commit ?? "unknown"}:`,
      item.handoff.body.trim() || "(no description)",
      "",
    );
  }
  for (const merge of input.merges) {
    if (merge.status === "merged") {
      lines.push(`The work at commit ${merge.commit} has been merged into your working directory.`);
    } else if (merge.status === "conflict") {
      lines.push(
        `Merging commit ${merge.commit} left conflicts in: ${(merge.files ?? []).join(", ")}.`,
        "Resolve the conflicts, keep the tests green, commit the merge, then continue with the task.",
      );
    }
  }
  lines.push("", "Do your part of the task and finish with exactly one JSON envelope.");
  return lines.join("\n");
}

export const auditPrompt = (commit: string): string =>
  [
    `Audit your work at commit ${commit}.`,
    "Re-check it against every requirement of the task and re-run the verification commands.",
    "If everything holds, repeat the identical handoff envelope. If you changed anything, commit it and return the new handoff envelope.",
  ].join("\n");

export const rejectionPrompt = (reason: string): string =>
  [
    `Your previous reply was rejected: ${reason}`,
    "Reply again with exactly one valid JSON envelope and nothing else.",
  ].join("\n");

export const answerPrompt = (answer: string): string =>
  [
    "The operator answered your question:",
    answer,
    "",
    "Continue the task and finish with exactly one JSON envelope.",
  ].join("\n");

/** Body of a coordinator-generated handoff: tells the receiver what to merge (spec 4.3). */
export function handoffBody(input: {
  from: string;
  commit: string;
  summary: string;
  evidence: Evidence[];
  nonForwarding: boolean;
}): string {
  const lines = [
    input.nonForwarding
      ? `Merge commit ${input.commit} from ${input.from}; no work is required.`
      : `Merge commit ${input.commit} from ${input.from} (git merge --no-edit ${input.commit}) and continue.`,
    "",
    `Summary: ${input.summary}`,
  ];
  if (input.evidence.length > 0) {
    lines.push("", "Evidence:");
    for (const item of input.evidence) lines.push(`- ${item.requirement}: ${item.proof}`);
  }
  return lines.join("\n");
}

export interface GateFailure {
  gate: string;
  findings: string[];
}

export const gateFailurePrompt = (failure: GateFailure, bounce: number, max: number): string =>
  [
    `The ${failure.gate} gate failed on your work (attempt ${bounce} of ${max} allowed).`,
    "Findings:",
    ...failure.findings.map((finding) => `- ${finding}`),
    "Fix every finding, commit, and return a new handoff envelope.",
  ].join("\n");

/** A restored clarification: the new session has no memory of the question, so it is repeated. */
export const resumedAnswerPrompt = (question: string, answer: string): string =>
  [`Earlier you asked: ${question}`, "The operator answered:", answer].join("\n");

/** Body of the note that sends a rejected task back to an earlier role (QA rejection routing). */
export const rejectionRouteBody = (from: string, findings: string): string =>
  [
    `${from} rejected the work. Continue from your existing work and fix every finding.`,
    "Keep the tests green and hand off again when done.",
    "",
    "Findings:",
    findings,
  ].join("\n");

/** Body of the note that re-runs the master role after the operator rejected its work. */
export function retryBody(input: {
  original: string;
  ref: string;
  findings: string;
  comments: Array<{ doc: string; text: string }>;
}): string {
  const lines = [
    input.original.trim(),
    "",
    "The operator rejected your previous attempt and asked for a retry.",
    `The rejected work is preserved at ${input.ref}.`,
  ];
  if (input.findings.trim()) lines.push("", "Findings:", input.findings.trim());
  if (input.comments.length > 0) {
    lines.push("", "Comments by document:");
    for (const comment of input.comments) lines.push(`- ${comment.doc}: ${comment.text}`);
  }
  return lines.join("\n");
}
