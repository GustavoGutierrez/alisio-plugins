import { randomUUID } from "node:crypto";
import type { Envelope } from "../domain/envelope.js";
import { parseEnvelope } from "../domain/envelope.js";
import { type Handoff, PHANTOM_SENDER, type StoredHandoff } from "../domain/handoff.js";
import { findRole, type Pack, roleIds } from "../domain/pack.js";
import {
  approvalRequiredAfter,
  joinSource,
  type ReleasePlan,
  releasePlan,
  route,
} from "../domain/pipeline.js";
import type { TaskCard } from "../domain/task.js";
import { type HoldKind, MAX_HOLD_TEXT, type TaskState } from "../domain/taskstate.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import type { Clock } from "../ports/clock.js";
import type { GateReport, GateRunner } from "../ports/gate-runner.js";
import type { HandoffStore } from "../ports/handoff-store.js";
import type { Isolation } from "../ports/isolation.js";
import type { ActivityKind, Notifier } from "../ports/notifier.js";
import type { TaskStateStore } from "../ports/task-state-store.js";
import { Mutex } from "../storage.js";
import { type AuditState, nextAudit, startAudit } from "./audit.js";
import { budgetAttention, type UsageMeter } from "./budget.js";
import {
  answerPrompt,
  auditPrompt,
  gateFailurePrompt,
  handoffBody,
  type MergeNote,
  rejectionPrompt,
  rejectionRouteBody,
  resumedAnswerPrompt,
  rolePrompt,
} from "./prompts.js";

/** What the pump needs from its project (implemented by `ProjectRuntime`). */
export interface PumpHost {
  readonly name: string;
  readonly pack: Pack;
  readonly isolation: Isolation;
  readonly runner: AgentRunner;
  readonly handoffs: HandoffStore;
  readonly state: TaskStateStore;
  readonly clock: Clock;
  readonly notifier: Notifier;
  readonly maxConcurrent: number;
  readonly tickMs: number;
  /** Deterministic quality gates; absent means the pack's gates are not enforced. */
  readonly gates?: GateRunner;
  readonly meter?: UsageMeter;
  workdir(role: string): string;
  card(taskId: string): TaskCard | undefined;
  updateCard(
    taskId: string,
    patch: Partial<Pick<TaskCard, "lane" | "status" | "auditCount">>,
  ): Promise<void>;
}

interface RoleRun {
  role: string;
  workdir: string;
  taskName: string;
  taskId: string;
  items: StoredHandoff[];
  retried: boolean;
  /** Gate failures and rejections so far for this role and task. */
  bounces: number;
  /** HEAD of the working directory before the role started (gates diff against it). */
  baseline?: string;
  audit?: AuditState | undefined;
  parked?: StoredHandoff;
}

export type Held = RoleRun & {
  reason: HoldKind;
  text: string;
  /** Rebuilt from a persisted hold after a restart: there is no session or parked handoff. */
  restored?: boolean;
};

type Reply =
  | { type: "envelope"; envelope: Envelope }
  | { type: "rejected"; reason: string }
  | { type: "cancelled" };

interface GateFailure {
  report: GateReport;
  infrastructure: boolean;
}

const noop = (): void => undefined;
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const statusFor = (reason: HoldKind): "clarifying" | "blocked" =>
  reason === "clarifying" ? "clarifying" : "blocked";

/**
 * In-process handoff pump (AD-4): delivers handoffs, runs one role at a time per task, drives the
 * audit handshake and the quality gates. Event-driven (`wake`) with a safety tick; `drain` runs to
 * quiescence for tests and for the foreground `run` command.
 */
export class Pump {
  private readonly running = new Map<string, Promise<void>>();
  private readonly active = new Map<string, string>();
  private readonly holds = new Map<string, Held>();
  private readonly tickLock = new Mutex();
  private timer: NodeJS.Timeout | undefined;
  private halted = false;

  constructor(private readonly host: PumpHost) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(noop), this.host.tickMs);
    this.timer.unref();
    this.wake();
  }

  /** Stop scheduling new runs; in-flight runs are awaited by `settled`. */
  halt(): void {
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  wake(): void {
    if (!this.timer || this.halted) return;
    setImmediate(() => void this.tick().catch(noop));
  }

  isHalted(): boolean {
    return this.halted;
  }

  /** The soft token cap is reached: no new runs start until the operator raises it. */
  isPaused(): boolean {
    return this.host.meter?.exceeded === true;
  }

  /** The task is being worked on by a role right now. */
  isTaskRunning(taskId: string): boolean {
    return [...this.active.values()].includes(taskId);
  }

  /** One line for the dashboard activity log; never throws into the pump. */
  private activity(kind: ActivityKind, run: RoleRun, message: string): void {
    this.host.notifier.notify({
      type: "activity",
      project: this.host.name,
      at: this.host.clock.now().toISOString(),
      kind,
      role: run.role,
      task: run.taskName,
      message,
    });
  }

  /** Roles running right now, with the task each one works on. */
  activeRoles(): Map<string, string> {
    return new Map(this.active);
  }

  /** The hold of a task (clarification, block or gate failure), if any. */
  holdOf(taskId: string): Held | undefined {
    return [...this.holds.values()].find((held) => held.taskId === taskId);
  }

  /** Start a run for every idle role that has mail, up to the concurrency cap. */
  tick(): Promise<void> {
    return this.tickLock.run(async () => {
      if (this.halted || this.isPaused()) return;
      for (const role of roleIds(this.host.pack)) {
        if (this.running.size >= this.host.maxConcurrent) break;
        if (this.running.has(role) || this.holds.has(role)) continue;
        if ((await this.host.handoffs.pending(role)) === 0) continue;
        this.track(role, this.runRole(role));
      }
    });
  }

  private track(role: string, work: Promise<void>): void {
    const tracked = work.catch(noop).finally(() => {
      this.running.delete(role);
      this.active.delete(role);
      this.wake();
    });
    this.running.set(role, tracked);
  }

  private async hasWork(): Promise<boolean> {
    if (this.halted || this.isPaused()) return false;
    for (const role of roleIds(this.host.pack)) {
      if (this.holds.has(role)) continue;
      if ((await this.host.handoffs.pending(role)) > 0) return true;
    }
    return false;
  }

  /** Run until no role has mail (held roles excluded) and nothing is running. */
  async drain(): Promise<void> {
    for (;;) {
      await this.tick();
      if (this.running.size === 0) {
        if (!(await this.hasWork())) return;
        continue;
      }
      await Promise.race([...this.running.values()]);
    }
  }

  // ---- operator actions on holds ----

  async answer(taskId: string, text: string): Promise<void> {
    const held = this.holdOf(taskId);
    if (held?.reason !== "clarifying") {
      throw new Error("The task is not waiting for an answer");
    }
    this.holds.delete(held.role);
    if (held.restored) {
      // The session is gone: the answer travels in the next prompt of a fresh run.
      await this.host.state.update(taskId, held.taskName, (state) => {
        state.hold = undefined;
        state.answer = { question: held.text, text };
      });
      await this.host.updateCard(taskId, { lane: held.role, status: "queued" });
      this.wake();
      return;
    }
    await this.clearHold(held, false);
    held.retried = false;
    await this.host.updateCard(taskId, { status: "working" });
    this.active.set(held.role, taskId);
    const work = this.converse(held, answerPrompt(text)).catch((error) => this.fail(held, error));
    this.track(held.role, work);
    await work;
  }

  /** Retry: put a held role's work back in its inbox with a fresh allowance. */
  async releaseHold(taskId: string): Promise<void> {
    const held = this.holdOf(taskId);
    if (!held) throw new Error("There is nothing to retry: the task is not held");
    this.holds.delete(held.role);
    if (held.parked) await this.host.handoffs.discard(held.parked);
    for (const item of held.items) {
      await this.host.handoffs.move(item, { kind: "inbox", role: held.role, box: "new" });
    }
    await this.clearHold(held, true);
    await this.host.updateCard(taskId, { lane: held.role, status: "queued" });
    this.wake();
  }

  /** Accept the held work as it is: release its parked handoff despite the failure. */
  async acceptHold(taskId: string): Promise<void> {
    const held = this.holdOf(taskId);
    if (!held?.parked || held.restored || held.reason === "clarifying") {
      throw new Error("There is nothing to accept: retry or delete the task instead");
    }
    this.holds.delete(held.role);
    await this.clearHold(held, true);
    await this.release(held);
  }

  /** A held task is deleted: forget the hold without touching files (the operator archives them). */
  forget(taskId: string): void {
    const held = this.holdOf(taskId);
    if (held) this.holds.delete(held.role);
  }

  /** Rebuild a hold from its persisted state after a restart. */
  restoreHold(state: TaskState): void {
    const hold = state.hold;
    if (!hold) return;
    this.holds.set(hold.role, {
      role: hold.role,
      workdir: this.host.workdir(hold.role),
      taskName: state.task,
      taskId: state.taskId,
      items: [],
      retried: false,
      bounces: state.bounces[hold.role] ?? 0,
      reason: hold.kind,
      text: hold.text,
      restored: true,
    });
  }

  private async clearHold(held: Held, resetBounces: boolean): Promise<void> {
    const state = await this.host.state.get(held.taskId);
    if (!state?.hold && !(resetBounces && state?.bounces[held.role])) return;
    await this.host.state.update(held.taskId, held.taskName, (current) => {
      current.hold = undefined;
      if (resetBounces) current.bounces[held.role] = 0;
    });
  }

  // ---- running a role ----

  private async runRole(role: string): Promise<void> {
    const def = findRole(this.host.pack, role);
    if (!def) return;
    const batch = def.receive === "batch" || joinSource(this.host.pack, role) !== undefined;
    const items = await this.host.handoffs.claim(role, { batch });
    const first = items[0];
    if (!first) return;
    const order = roleIds(this.host.pack);
    items.sort((a, b) => order.indexOf(a.handoff.from) - order.indexOf(b.handoff.from));
    this.active.set(role, first.handoff.taskId);
    const state = await this.host.state.get(first.handoff.taskId);
    const run: RoleRun = {
      role,
      workdir: this.host.workdir(role),
      taskName: first.handoff.task,
      taskId: first.handoff.taskId,
      items,
      retried: false,
      bounces: state?.bounces[role] ?? 0,
    };
    try {
      const work = items.filter((item) => !item.handoff.nonForwarding);
      const copies = items.filter((item) => item.handoff.nonForwarding);
      const merges: MergeNote[] = [];
      for (const item of copies) await this.mergeCopy(run, item);
      if (work.length === 0) {
        await this.host.handoffs.complete(items);
        return;
      }
      await this.host.updateCard(run.taskId, { lane: role, status: "working" });
      for (const item of work) {
        const commit = item.handoff.commit;
        if (!commit) continue;
        const result = await this.host.isolation.merge(run.workdir, commit);
        if (result.status === "error") {
          return await this.hold(
            run,
            "blocked",
            `Merging ${commit} failed: ${result.message ?? "unknown error"}`,
            false,
          );
        }
        this.activity("merge", run, `Merged ${commit} into ${role}: ${result.status}`);
        merges.push({
          commit,
          status: result.status,
          ...(result.files ? { files: result.files } : {}),
        });
      }
      if (merges.some((merge) => merge.status === "conflict")) {
        await this.host.updateCard(run.taskId, { status: "merging" });
      }
      run.baseline = await this.host.isolation.headCommit(run.workdir);
      const baseline = run.baseline;
      if (!state?.bases[role]) {
        await this.host.state.update(run.taskId, run.taskName, (current) => {
          current.bases[role] = baseline;
        });
      }
      const prompt = [
        rolePrompt({
          project: this.host.name,
          role,
          task: run.taskName,
          taskId: run.taskId,
          items: work,
          merges,
        }),
        ...(state?.answer
          ? ["", resumedAnswerPrompt(state.answer.question, state.answer.text)]
          : []),
      ].join("\n");
      if (state?.answer) {
        await this.host.state.update(run.taskId, run.taskName, (current) => {
          current.answer = undefined;
        });
      }
      await this.converse(run, prompt);
    } catch (error) {
      await this.fail(run, error);
    }
  }

  /** A merge-only copy: merge when possible, never leave a conflicted tree behind. */
  private async mergeCopy(run: RoleRun, item: StoredHandoff): Promise<void> {
    const commit = item.handoff.commit;
    if (!commit) return;
    const result = await this.host.isolation.merge(run.workdir, commit);
    if (result.status === "conflict") await this.host.isolation.abortMerge(run.workdir);
    if (result.status === "conflict" || result.status === "error") {
      this.host.notifier.notify({
        type: "error",
        project: this.host.name,
        message: `Could not merge ${commit} into the ${run.role} working directory`,
      });
    }
  }

  private async ask(run: RoleRun, prompt: string): Promise<Reply> {
    const agent = findRole(this.host.pack, run.role)?.agent ?? run.role;
    const result = await this.host.runner.run({
      sessionKey: `${this.host.name}/${run.role}`,
      project: this.host.name,
      role: run.role,
      agent,
      workdir: run.workdir,
      prompt,
    });
    await this.record(result.usage);
    if (result.status === "cancelled") return { type: "cancelled" };
    if (result.status === "failed") {
      return { type: "rejected", reason: `The run failed: ${result.error ?? "unknown error"}` };
    }
    const parsed = parseEnvelope(result.text, {
      ...(result.turnsExceeded ? { turnsExceeded: true } : {}),
    });
    return parsed.ok
      ? { type: "envelope", envelope: parsed.envelope }
      : { type: "rejected", reason: parsed.reason };
  }

  private async record(usage: { input: number; output: number } | undefined): Promise<void> {
    const meter = this.host.meter;
    if (!usage || !meter) return;
    try {
      if (await meter.record(usage.input + usage.output)) {
        const item = budgetAttention(this.host.name, meter, this.host.clock.now().toISOString());
        if (item) this.host.notifier.notify({ type: "attention", item });
      }
    } catch {
      // The meter only guards cost: a failed write must not fail the run.
    }
  }

  private async converse(run: RoleRun, firstPrompt: string): Promise<void> {
    let prompt = firstPrompt;
    const reject = async (reason: string): Promise<boolean> => {
      if (run.retried) {
        await this.hold(run, "blocked", `Output rejected twice: ${reason}`, false);
        return false;
      }
      run.retried = true;
      prompt = rejectionPrompt(reason);
      return true;
    };
    for (;;) {
      const reply = await this.ask(run, prompt);
      if (reply.type === "cancelled") return this.requeue(run);
      if (reply.type === "rejected") {
        if (await reject(reply.reason)) continue;
        return;
      }
      const envelope = reply.envelope;
      if (envelope.kind === "needs_clarification") {
        return this.hold(run, "clarifying", envelope.question, true);
      }
      if (envelope.kind === "blocked") {
        if (this.rejectsBack(run.role)) return this.rejectBack(run, envelope.reason);
        return this.hold(run, "blocked", envelope.reason, true);
      }
      if (envelope.kind === "note") {
        if (await reject("A note envelope is not accepted here; hand off, ask or report blocked"))
          continue;
        return;
      }
      if (!(await this.host.isolation.hasCommit(run.workdir, envelope.commit))) {
        if (await reject(`Commit ${envelope.commit} does not exist in your working directory`))
          continue;
        return;
      }
      if (!run.audit) {
        run.audit = startAudit(envelope.commit);
        await this.park(run, envelope);
        prompt = auditPrompt(envelope.commit);
        continue;
      }
      const step = nextAudit(run.audit, envelope.commit, this.host.pack.limits.maxAuditRounds);
      if (step.action === "release") {
        const next = await this.afterAudit(run);
        if (next === undefined) return;
        prompt = next;
        continue;
      }
      if (step.action === "exhausted") {
        return this.hold(
          run,
          "blocked",
          `No stable commit after ${step.challenges} audit rounds`,
          false,
        );
      }
      run.audit = step.state;
      await this.park(run, envelope);
      prompt = auditPrompt(envelope.commit);
    }
  }

  // ---- quality gates (AD-6) ----

  private async checkGates(run: RoleRun): Promise<GateFailure | undefined> {
    const gates = this.host.gates;
    const names = this.host.pack.gates[run.role] ?? [];
    if (!gates || names.length === 0) return undefined;
    for (const gate of names) {
      const report = await gates.run({
        project: this.host.name,
        task: run.taskName,
        role: run.role,
        gate,
        workdir: run.workdir,
        toolchain: this.host.pack.toolchain,
        thresholds: this.host.pack.thresholds,
        ...(run.baseline ? { since: run.baseline } : {}),
      });
      this.activity(
        "gate",
        run,
        `${gate}: ${report.error ? "could not run" : report.passed ? "passed" : "failed"}`,
      );
      if (report.error) return { report, infrastructure: true };
      if (!report.passed) return { report, infrastructure: false };
    }
    return undefined;
  }

  /**
   * Run the role's gates after an unchanged audit. A failing gate bounces the report back to the
   * same role (a new audit round) until `maxBounces`, then the task is held for a decision.
   * Returns the next prompt to continue the conversation, or `undefined` when the run is over.
   */
  private async afterAudit(run: RoleRun): Promise<string | undefined> {
    const failure = await this.checkGates(run);
    if (!failure) {
      await this.release(run);
      return undefined;
    }
    const { report } = failure;
    if (failure.infrastructure) {
      if (this.halted) {
        await this.requeue(run);
        return undefined;
      }
      await this.hold(
        run,
        "gate-failed",
        `The ${report.gate} gate could not run: ${report.error ?? "unknown error"}`,
        true,
      );
      return undefined;
    }
    const findings = report.findings.length > 0 ? report.findings : [`${report.gate} failed`];
    run.bounces += 1;
    const limit = this.host.pack.limits.maxBounces;
    const bounces = run.bounces;
    this.activity("bounce", run, `${report.gate} failed: bounce ${bounces} of ${limit}`);
    await this.host.state.update(run.taskId, run.taskName, (state) => {
      state.bounces[run.role] = bounces;
    });
    if (run.bounces > limit) {
      await this.hold(
        run,
        "gate-failed",
        [
          `The ${report.gate} gate still fails after ${limit} bounce(s):`,
          ...findings.map((f) => `- ${f}`),
        ].join("\n"),
        true,
      );
      return undefined;
    }
    run.audit = undefined;
    return gateFailurePrompt({ gate: report.gate, findings }, run.bounces, limit);
  }

  // ---- QA rejection routing (spec 8.4) ----

  /** Only the last role (the terminal acceptance role) routes findings back. */
  private rejectsBack(role: string): boolean {
    const ids = roleIds(this.host.pack);
    return ids.length > 1 && ids.at(-1) === role;
  }

  private rejectTarget(role: string, findings: string): string {
    const ids = roleIds(this.host.pack);
    const index = ids.indexOf(role);
    const hint = /^route:\s*([a-z][a-z0-9-]{0,23})\s*$/m.exec(findings)?.[1];
    if (hint && ids.indexOf(hint) >= 0 && ids.indexOf(hint) < index) return hint;
    const configured = findRole(this.host.pack, role)?.rejectTo;
    if (configured) return configured;
    return ids.includes("coder") && ids.indexOf("coder") < index ? "coder" : (ids[0] as string);
  }

  private async rejectBack(run: RoleRun, findings: string): Promise<void> {
    const limit = this.host.pack.limits.maxBounces;
    run.bounces += 1;
    const bounces = run.bounces;
    await this.host.state.update(run.taskId, run.taskName, (state) => {
      state.bounces[run.role] = bounces;
    });
    if (run.bounces > limit) {
      return this.hold(
        run,
        "blocked",
        `${run.role} rejected the work ${run.bounces} times (limit ${limit}). Last findings:\n${findings}`,
        true,
      );
    }
    const target = this.rejectTarget(run.role, findings);
    const note: Handoff = {
      id: randomUUID(),
      from: PHANTOM_SENDER,
      to: [target],
      priority: run.items[0]?.handoff.priority ?? 50,
      type: "note",
      task: run.taskName,
      taskId: run.taskId,
      approved: false,
      nonForwarding: false,
      createdAt: this.host.clock.now().toISOString(),
      body: rejectionRouteBody(run.role, findings),
    };
    await this.host.handoffs.inject(note);
    await this.host.handoffs.complete(run.items);
    if (run.parked) await this.host.handoffs.discard(run.parked);
    await this.host.updateCard(run.taskId, { lane: target, status: "queued" });
  }

  // ---- parking and delivery ----

  /** Build the outgoing handoff for a verified envelope and park it as `audit_pending`. */
  private async park(
    run: RoleRun,
    envelope: Extract<Envelope, { kind: "handoff" }>,
  ): Promise<void> {
    if (run.parked) await this.host.handoffs.discard(run.parked);
    const plan = releasePlan(this.host.pack, run.role);
    const to = plan.terminal && plan.to.length === 0 ? [run.role] : plan.to;
    const handoff: Handoff = {
      id: randomUUID(),
      from: run.role,
      to,
      priority: run.items[0]?.handoff.priority ?? 50,
      type: "git_handoff",
      task: run.taskName,
      taskId: run.taskId,
      commit: envelope.commit,
      approved: false,
      nonForwarding: plan.terminal,
      createdAt: this.host.clock.now().toISOString(),
      body: handoffBody({
        from: run.role,
        commit: envelope.commit,
        summary: envelope.summary,
        evidence: envelope.evidence,
        nonForwarding: plan.terminal,
      }),
    };
    run.parked = await this.host.handoffs.write(handoff, { kind: "audit_pending", role: run.role });
    this.activity("handoff", run, `Handed off ${envelope.commit} (audit pending)`);
  }

  private async release(run: RoleRun): Promise<void> {
    const parked = run.parked as StoredHandoff;
    const plan = releasePlan(this.host.pack, run.role);
    const audits = (this.host.card(run.taskId)?.auditCount ?? 0) + 1;
    await this.settle(run);
    if (approvalRequiredAfter(this.host.pack, run.role) && !plan.terminal) {
      await this.host.handoffs.move(parked, { kind: "pending_approval", role: run.role });
      this.activity("approval", run, "Waiting for your approval");
      await this.host.handoffs.complete(run.items);
      await this.host.updateCard(run.taskId, {
        lane: run.role,
        status: "waiting_approval",
        auditCount: audits,
      });
      return;
    }
    if (plan.stage) {
      await this.host.handoffs.move(parked, { kind: "join_pending", role: run.role });
      await this.host.handoffs.complete(run.items);
      await this.host.updateCard(run.taskId, {
        lane: run.role,
        status: "working",
        auditCount: audits,
      });
      await this.tryJoin(run.taskId, plan.stage);
      return;
    }
    await this.deliverParked(parked, { items: run.items, auditCount: audits });
  }

  /** A role that finished cleanly forgets its bounces and any stale hold. */
  private async settle(run: RoleRun): Promise<void> {
    const state = await this.host.state.get(run.taskId);
    if (!state || (!state.hold && !state.bounces[run.role])) return;
    await this.host.state.update(run.taskId, run.taskName, (current) => {
      current.hold = undefined;
      current.bounces[run.role] = 0;
    });
  }

  /**
   * Deliver a parked handoff: outbox, merge-only copies for earlier roles, then the recipients.
   * Used by the audit release, the approval gate and the parallel join.
   */
  async deliverParked(
    parked: StoredHandoff,
    options: { items?: StoredHandoff[]; auditCount?: number; approve?: boolean } = {},
  ): Promise<void> {
    const role = parked.location.role;
    const plan: ReleasePlan = releasePlan(this.host.pack, role);
    const outbox = await this.host.handoffs.move(
      parked,
      { kind: "outbox", role },
      options.approve ? { approved: true } : {},
    );
    let extra: StoredHandoff | undefined;
    const mergeOnly = route(this.host.pack, role).mergeOnly;
    if (!plan.terminal && mergeOnly.length > 0) {
      extra = await this.host.handoffs.write(
        {
          ...parked.handoff,
          id: randomUUID(),
          to: mergeOnly,
          nonForwarding: true,
          body: handoffBody({
            from: role,
            commit: parked.handoff.commit as string,
            summary: "Earlier roles merge this work.",
            evidence: [],
            nonForwarding: true,
          }),
        },
        { kind: "outbox", role },
      );
    }
    // Complete the inbox items before delivering: the outbox file is durable, so a crash in between
    // is replayed by `recover` instead of re-running the role.
    if (options.items) await this.host.handoffs.complete(options.items);
    await this.host.handoffs.deliver(outbox);
    if (extra) await this.host.handoffs.deliver(extra);
    const auditPatch = options.auditCount !== undefined ? { auditCount: options.auditCount } : {};
    if (plan.terminal) {
      await this.host.updateCard(parked.handoff.taskId, {
        lane: "done",
        status: "done",
        ...auditPatch,
      });
      this.host.notifier.notify({
        type: "task-done",
        project: this.host.name,
        task: parked.handoff.task,
      });
    } else {
      await this.host.updateCard(parked.handoff.taskId, {
        lane: plan.to[0] as string,
        status: "queued",
        ...auditPatch,
      });
    }
  }

  // ---- parallel stage join (spec 4.2, 8.4) ----

  /**
   * Deliver the parked handoffs of a stage once every stage role has handed off, in pack order.
   * The tick lock is held so the next role never claims a half-delivered join.
   */
  tryJoin(taskId: string, stage: string[]): Promise<void> {
    return this.tickLock.run(async () => {
      const { records } = await this.host.handoffs.scan();
      const parked = stage.map((role) =>
        records.find(
          (record) =>
            record.location.kind === "join_pending" &&
            record.location.role === role &&
            record.handoff.taskId === taskId,
        ),
      );
      if (parked.some((record) => !record)) return;
      for (const record of parked as StoredHandoff[]) await this.deliverParked(record);
      this.wake();
    });
  }

  /** After a restart: complete joins whose stage roles had all handed off before the crash. */
  async resumeJoins(): Promise<void> {
    const stages = this.host.pack.parallel ?? [];
    if (stages.length === 0) return;
    const { records } = await this.host.handoffs.scan();
    for (const stage of stages) {
      const tasks = new Set(
        records
          .filter((r) => r.location.kind === "join_pending" && stage.includes(r.location.role))
          .map((r) => r.handoff.taskId),
      );
      for (const taskId of tasks) await this.tryJoin(taskId, stage);
    }
  }

  // ---- holds ----

  /** Hold the role (it keeps its in-process items) and ask the operator. */
  private async hold(
    run: RoleRun,
    reason: HoldKind,
    text: string,
    persist: boolean,
  ): Promise<void> {
    this.holds.set(run.role, { ...run, reason, text });
    if (persist) {
      await this.host.state.update(run.taskId, run.taskName, (state) => {
        state.hold = {
          kind: reason,
          role: run.role,
          text: text.slice(0, MAX_HOLD_TEXT),
          createdAt: this.host.clock.now().toISOString(),
        };
      });
    }
    await this.host.updateCard(run.taskId, { status: statusFor(reason) });
  }

  /** A cancelled run puts the work back and stops the pump (project closing). */
  private async requeue(run: RoleRun): Promise<void> {
    this.halted = true;
    if (run.parked) await this.host.handoffs.discard(run.parked);
    for (const item of run.items) {
      await this.host.handoffs.move(item, { kind: "inbox", role: run.role, box: "new" });
    }
    await this.host.updateCard(run.taskId, { lane: run.role, status: "queued" });
  }

  private async fail(run: RoleRun, error: unknown): Promise<void> {
    this.host.notifier.notify({ type: "error", project: this.host.name, message: message(error) });
    await this.hold(run, "blocked", message(error), false).catch(noop);
  }
}
