import type { Board, TaskStatus } from "./task.js";
import type { TaskState } from "./taskstate.js";

export type AttentionKind = "approval" | "clarification" | "blocked" | "gate-failed" | "decision";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  project: string;
  task: string;
  createdAt: string;
  /** Operator actions allowed on this item. */
  actions: string[];
  /** The question, reason or findings behind the item, when known. Always rendered as text. */
  detail?: string;
}

const table: Partial<Record<TaskStatus, { kind: AttentionKind; actions: string[] }>> = {
  waiting_approval: { kind: "approval", actions: ["documents", "approve", "reject"] },
  clarifying: { kind: "clarification", actions: ["answer"] },
  blocked: { kind: "blocked", actions: ["retry", "delete", "accept"] },
  rejected: { kind: "decision", actions: ["retry", "delete", "accept"] },
};

/**
 * Items that need a human, derived from the board and the persisted task states (holds and
 * approval comments). Approve is not offered while per-document comments exist (spec 8.3).
 */
export function deriveAttention(
  project: string,
  board: Board,
  states?: ReadonlyMap<string, TaskState>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const card of board.tasks) {
    const entry = table[card.status];
    if (!entry) continue;
    const state = states?.get(card.taskId);
    let kind = entry.kind;
    let actions = [...entry.actions];
    let detail: string | undefined;
    if (card.status === "blocked" && state?.hold?.kind === "gate-failed") kind = "gate-failed";
    if (card.status === "waiting_approval" && state && state.comments.length > 0) {
      actions = ["documents", "comment", "reject"];
      detail = `${state.comments.length} comment(s) must be resolved before approving`;
    }
    if (state?.hold && card.status !== "waiting_approval") detail = state.hold.text;
    items.push({
      id: `${kind}:${project}:${card.name}`,
      kind,
      project,
      task: card.name,
      createdAt: card.updatedAt,
      actions,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return items;
}
