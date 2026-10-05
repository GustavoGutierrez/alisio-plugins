import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Handoff, PHANTOM_SENDER, type StoredHandoff } from "../domain/handoff.js";
import type { Pack } from "../domain/pack.js";
import type { TaskCard } from "../domain/task.js";
import { MAX_HOLD_TEXT } from "../domain/taskstate.js";
import type { Clock } from "../ports/clock.js";
import type { HandoffStore } from "../ports/handoff-store.js";
import type { Isolation } from "../ports/isolation.js";
import type { TaskStateStore } from "../ports/task-state-store.js";
import { assertRelativePath, atomicWrite } from "../storage.js";
import { retryBody } from "./prompts.js";
import type { Pump } from "./pump.js";

/** What the operator actions need from their project (implemented by `ProjectRuntime`). */
export interface OperatorHost {
  readonly name: string;
  readonly dir: string;
  readonly pack: Pack;
  readonly isolation: Isolation;
  readonly handoffs: HandoffStore;
  readonly state: TaskStateStore;
  readonly clock: Clock;
  readonly pump: Pump;
  workdir(role: string): string;
  cardByName(name: string): TaskCard;
  updateCard(
    taskId: string,
    patch: Partial<Pick<TaskCard, "lane" | "status" | "auditCount">>,
  ): Promise<void>;
  removeCard(taskId: string): Promise<void>;
}

export type RejectAction = "retry" | "delete" | "accept";
export const rejectActions: readonly RejectAction[] = ["retry", "delete", "accept"];

/**
 * Human decisions on a task (approve, reject, retry, delete, accept, comments). One implementation
 * behind the commands, the tools and the dashboard (AD-10).
 */
export class Operator {
  constructor(private readonly host: OperatorHost) {}

  private async pendingApproval(card: TaskCard): Promise<StoredHandoff> {
    const { records } = await this.host.handoffs.scan();
    const record = records.find(
      (candidate) =>
        candidate.location.kind === "pending_approval" && candidate.handoff.taskId === card.taskId,
    );
    if (!record) throw new Error(`Task ${card.name} is not waiting for approval`);
    return record;
  }

  async approve(name: string): Promise<void> {
    const card = this.host.cardByName(name);
    const record = await this.pendingApproval(card);
    const state = await this.host.state.get(card.taskId);
    if (state && state.comments.length > 0) {
      throw new Error(
        `Resolve the ${state.comments.length} comment(s) on the documents before approving, or reject the task`,
      );
    }
    await this.host.pump.deliverParked(record, { approve: true });
    this.host.pump.wake();
  }

  async reject(name: string, action: RejectAction, comments = ""): Promise<void> {
    if (!rejectActions.includes(action)) {
      throw new Error("Reject needs one of: retry, delete, accept");
    }
    if (action === "delete") return this.delete(name);
    if (action === "accept") {
      const card = this.host.cardByName(name);
      const record = await this.pendingApproval(card);
      await this.clearComments(name);
      await this.host.pump.deliverParked(record, { approve: true });
      this.host.pump.wake();
      return;
    }
    return this.retryRejected(name, comments);
  }

  /** Retry: snapshot the rejected commit, restore the base, count the audit and re-run the role. */
  private async retryRejected(name: string, findings: string): Promise<void> {
    const card = this.host.cardByName(name);
    const record = await this.pendingApproval(card);
    const role = record.location.role;
    const workdir = this.host.workdir(role);
    const state = await this.host.state.get(card.taskId);
    const base = state?.bases[role];
    const ref = `refs/swarm/rejected/${card.name}`;
    if (record.handoff.commit)
      await this.host.isolation.snapshotRef(workdir, ref, record.handoff.commit);
    // Restoring can refuse (uncommitted changes): do it before anything is discarded.
    if (base) await this.host.isolation.restoreTo(workdir, base);
    const { records } = await this.host.handoffs.scan();
    const original = records
      .filter(
        (r) =>
          r.handoff.taskId === card.taskId &&
          r.handoff.type === "note" &&
          r.handoff.from === PHANTOM_SENDER,
      )
      .sort((a, b) => a.handoff.createdAt.localeCompare(b.handoff.createdAt))[0];
    const comments = state?.comments ?? [];
    const note: Handoff = {
      id: randomUUID(),
      from: PHANTOM_SENDER,
      to: [role],
      priority: record.handoff.priority,
      type: "note",
      task: card.name,
      taskId: card.taskId,
      approved: false,
      nonForwarding: false,
      createdAt: this.host.clock.now().toISOString(),
      body: retryBody({
        original: original?.handoff.body ?? `Task ${card.name}`,
        ref,
        findings: findings.slice(0, MAX_HOLD_TEXT),
        comments,
      }),
    };
    await this.host.handoffs.discard(record);
    await this.host.handoffs.inject(note);
    await this.host.state.update(card.taskId, card.name, (current) => {
      current.rejections += 1;
      current.comments = [];
      current.hold = undefined;
    });
    await this.host.updateCard(card.taskId, {
      lane: role,
      status: "queued",
      auditCount: card.auditCount + 1,
    });
    this.host.pump.wake();
  }

  /** Retry a held task (blocked, gate-failed or clarifying) with a fresh allowance. */
  async retry(name: string): Promise<void> {
    const card = this.host.cardByName(name);
    await this.host.pump.releaseHold(card.taskId);
  }

  /** Accept the work as it is: an approval gate or a gate failure the operator overrides. */
  async accept(name: string): Promise<void> {
    const card = this.host.cardByName(name);
    if (card.status === "waiting_approval") return this.reject(name, "accept");
    await this.host.pump.acceptHold(card.taskId);
  }

  /** Delete: archive the task, then remove its card, handoffs and state. */
  async delete(name: string): Promise<void> {
    const card = this.host.cardByName(name);
    if (this.host.pump.isTaskRunning(card.taskId)) {
      throw new Error(`Task ${card.name} is running; stop the project before deleting it`);
    }
    this.host.pump.forget(card.taskId);
    const { records } = await this.host.handoffs.scan();
    const mine = records.filter((record) => record.handoff.taskId === card.taskId);
    await atomicWrite(
      join(this.host.dir, ".alisio", "swarm", "archive", `${card.taskId}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          archivedAt: this.host.clock.now().toISOString(),
          card,
          state: (await this.host.state.get(card.taskId)) ?? null,
          handoffs: mine.map((record) => ({
            location: record.location,
            fileName: record.fileName,
            handoff: record.handoff,
          })),
        },
        null,
        2,
      )}\n`,
    );
    await this.host.handoffs.purge(card.taskId);
    await this.host.state.remove(card.taskId);
    await this.host.removeCard(card.taskId);
  }

  async addComment(name: string, doc: string, text: string): Promise<void> {
    const card = this.host.cardByName(name);
    if (card.status !== "waiting_approval") {
      throw new Error(`Task ${card.name} is not waiting for approval`);
    }
    const path = assertRelativePath(doc);
    const body = text.trim();
    if (!body) throw new Error("A comment needs text");
    if (body.length > MAX_HOLD_TEXT) throw new Error("The comment is too long");
    await this.host.state.update(card.taskId, card.name, (state) => {
      state.comments.push({
        doc: path,
        text: body,
        createdAt: this.host.clock.now().toISOString(),
      });
    });
  }

  async clearComments(name: string): Promise<void> {
    const card = this.host.cardByName(name);
    const state = await this.host.state.get(card.taskId);
    if (!state || state.comments.length === 0) return;
    await this.host.state.update(card.taskId, card.name, (current) => {
      current.comments = [];
    });
  }
}
