import { randomUUID } from "node:crypto";
import { type AttentionItem, deriveAttention } from "../domain/attention.js";
import { type Handoff, PHANTOM_SENDER, type StoredHandoff } from "../domain/handoff.js";
import { makeTaskId, slugify, validateTaskName } from "../domain/identifiers.js";
import { type Pack, roleIds } from "../domain/pack.js";
import { entryRole } from "../domain/pipeline.js";
import { type Board, emptyBoard, rebuildBoard, type TaskCard } from "../domain/task.js";
import type { ApprovalComment, TaskState } from "../domain/taskstate.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import type { BoardStore } from "../ports/board-store.js";
import type { Clock } from "../ports/clock.js";
import type { GateRunner } from "../ports/gate-runner.js";
import type { HandoffStore } from "../ports/handoff-store.js";
import type { Isolation } from "../ports/isolation.js";
import type { Notifier } from "../ports/notifier.js";
import type { TaskStateStore } from "../ports/task-state-store.js";
import { Mutex } from "../storage.js";
import { budgetAttention, type UsageMeter } from "./budget.js";
import { Operator, type OperatorHost, type RejectAction } from "./operator.js";
import { Pump, type PumpHost } from "./pump.js";

export interface RuntimeDeps {
  name: string;
  dir: string;
  pack: Pack;
  isolation: Isolation;
  runner: AgentRunner;
  handoffs: HandoffStore;
  boards: BoardStore;
  states: TaskStateStore;
  clock: Clock;
  notifier: Notifier;
  maxConcurrent: number;
  autoStart: boolean;
  tickMs?: number;
  gates?: GateRunner;
  meter?: UsageMeter;
}

export const MAX_TASK_TEXT = 8000;

/** One open project: its stores, role working directories, board and pump. */
export class ProjectRuntime implements PumpHost, OperatorHost {
  readonly name: string;
  readonly dir: string;
  readonly pack: Pack;
  readonly isolation: Isolation;
  readonly runner: AgentRunner;
  readonly handoffs: HandoffStore;
  readonly clock: Clock;
  readonly notifier: Notifier;
  readonly maxConcurrent: number;
  readonly tickMs: number;
  readonly pump: Pump;
  readonly gates?: GateRunner;
  readonly meter?: UsageMeter;
  /** Task states behind a write-through cache, so `attention()` stays synchronous. */
  readonly state: TaskStateStore;
  private readonly operator: Operator;
  private readonly stateCache = new Map<string, TaskState>();

  private readonly boards: BoardStore;
  private readonly workdirs = new Map<string, string>();
  private readonly boardLock = new Mutex();
  private readonly creationLock = new Mutex();
  private board_: Board = emptyBoard();
  private taskSeq = 0;

  private constructor(deps: RuntimeDeps) {
    this.name = deps.name;
    this.dir = deps.dir;
    this.pack = deps.pack;
    this.isolation = deps.isolation;
    this.runner = deps.runner;
    this.handoffs = deps.handoffs;
    this.boards = deps.boards;
    this.clock = deps.clock;
    this.notifier = deps.notifier;
    this.maxConcurrent = deps.maxConcurrent;
    this.tickMs = deps.tickMs ?? 1000;
    if (deps.gates) this.gates = deps.gates;
    if (deps.meter) this.meter = deps.meter;
    this.state = this.cached(deps.states);
    this.pump = new Pump(this);
    this.operator = new Operator(this);
  }

  private cached(inner: TaskStateStore): TaskStateStore {
    const cache = this.stateCache;
    return {
      get: (taskId) => inner.get(taskId),
      list: () => inner.list(),
      async update(taskId, task, change) {
        const saved = await inner.update(taskId, task, change);
        cache.set(taskId, structuredClone(saved));
        return saved;
      },
      async remove(taskId) {
        await inner.remove(taskId);
        cache.delete(taskId);
      },
    };
  }

  static async open(deps: RuntimeDeps): Promise<ProjectRuntime> {
    const runtime = new ProjectRuntime(deps);
    await runtime.prepare();
    await runtime.pump.resumeJoins();
    if (deps.autoStart) runtime.pump.start();
    return runtime;
  }

  /** Create role directories, replay leftovers and rebuild the board from the handoff files. */
  private async prepare(): Promise<void> {
    await this.handoffs.ensureRoles(roleIds(this.pack));
    for (const role of this.pack.roles) {
      this.workdirs.set(
        role.id,
        await this.isolation.prepareRole(this.dir, this.name, {
          role: role.id,
          master: role.isolation === "master",
        }),
      );
    }
    await this.handoffs.recover();
    // Audits live in memory: a parking left by a dead process is redone, never trusted.
    const stale = (await this.handoffs.scan()).records.filter(
      (record) => record.location.kind === "audit_pending",
    );
    for (const record of stale) await this.handoffs.discard(record);
    // A restart is an implicit retry for runtime failures; operator decisions (clarifications,
    // agent-reported blocks, gate failures, approval comments) are persisted and restored here.
    const { records } = await this.handoffs.scan();
    const previous = await this.boards.read().catch(() => undefined);
    this.board_ = rebuildBoard(this.pack, records);
    for (const card of this.board_.tasks) {
      const before = previous?.tasks.find((candidate) => candidate.taskId === card.taskId);
      if (before) card.auditCount = Math.max(card.auditCount, before.auditCount);
    }
    for (const saved of await this.state.list()) {
      const card = this.board_.tasks.find((candidate) => candidate.taskId === saved.taskId);
      if (!card) {
        await this.state.remove(saved.taskId);
        continue;
      }
      this.stateCache.set(saved.taskId, saved);
      if (saved.hold && card.status !== "done") {
        this.pump.restoreHold(saved);
        card.lane = saved.hold.role;
        card.status = saved.hold.kind === "clarifying" ? "clarifying" : "blocked";
      }
    }
    await this.boards.write(this.board_);
  }

  workdir(role: string): string {
    const dir = this.workdirs.get(role);
    if (!dir) throw new Error(`Unknown role: ${role}`);
    return dir;
  }

  /** A copy of the board; mutating it never affects the runtime. */
  board(): Board {
    return structuredClone(this.board_);
  }

  card(taskId: string): TaskCard | undefined {
    return this.board_.tasks.find((card) => card.taskId === taskId);
  }

  attention(): AttentionItem[] {
    const items = deriveAttention(this.name, this.board_, this.stateCache);
    const budget = budgetAttention(this.name, this.meter, this.clock.now().toISOString());
    return budget ? [...items, budget] : items;
  }

  /** Roles running right now: role id to task name. */
  activeRoles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [role, taskId] of this.pump.activeRoles()) {
      const card = this.card(taskId);
      if (card) out.set(role, card.name);
    }
    return out;
  }

  /** The handoff held at the approval gate for a task. */
  async heldApproval(name: string): Promise<StoredHandoff> {
    const card = this.cardByName(name);
    const { records } = await this.handoffs.scan();
    const record = records.find(
      (candidate) =>
        candidate.location.kind === "pending_approval" && candidate.handoff.taskId === card.taskId,
    );
    if (!record) throw new Error(`Task ${card.name} is not waiting for approval`);
    return record;
  }

  cardByName(name: string): TaskCard {
    const card = this.board_.tasks.find((candidate) => candidate.name === name);
    if (!card) throw new Error(`Unknown task: ${name}`);
    return card;
  }

  removeCard(taskId: string): Promise<void> {
    return this.boardLock.run(async () => {
      this.board_.tasks = this.board_.tasks.filter((card) => card.taskId !== taskId);
      await this.boards.write(this.board_);
    });
  }

  /** Persisted per-document comments of a task waiting for approval. */
  comments(name: string): ApprovalComment[] {
    const card = this.cardByName(name);
    return structuredClone(this.stateCache.get(card.taskId)?.comments ?? []);
  }

  approve(name: string): Promise<void> {
    return this.operator.approve(name);
  }

  reject(name: string, action: RejectAction, comments?: string): Promise<void> {
    return this.operator.reject(name, action, comments);
  }

  retryTask(name: string): Promise<void> {
    return this.operator.retry(name);
  }

  acceptTask(name: string): Promise<void> {
    return this.operator.accept(name);
  }

  deleteTask(name: string): Promise<void> {
    return this.operator.delete(name);
  }

  addComment(name: string, doc: string, text: string): Promise<void> {
    return this.operator.addComment(name, doc, text);
  }

  clearComments(name: string): Promise<void> {
    return this.operator.clearComments(name);
  }

  updateCard(
    taskId: string,
    patch: Partial<Pick<TaskCard, "lane" | "status" | "auditCount">>,
  ): Promise<void> {
    return this.boardLock.run(async () => {
      const card = this.board_.tasks.find((candidate) => candidate.taskId === taskId);
      if (!card) return;
      const before = card.status;
      Object.assign(card, patch, { updatedAt: this.clock.now().toISOString() });
      await this.boards.write(this.board_);
      if (patch.status && patch.status !== before) {
        for (const item of deriveAttention(
          this.name,
          { schemaVersion: 1, tasks: [card] },
          this.stateCache,
        )) {
          this.notifier.notify({ type: "attention", item });
        }
      }
    });
  }

  /** Create a card and queue the task text as a note from the phantom sender to the master role. */
  newTask(text: string, explicitName?: string): Promise<TaskCard> {
    const body = text.trim();
    if (!body) return Promise.reject(new Error("Task text is required"));
    if (body.length > MAX_TASK_TEXT) {
      return Promise.reject(new Error(`Task text is too long (max ${MAX_TASK_TEXT} characters)`));
    }
    return this.creationLock.run(async () => {
      const taken = new Set(this.board_.tasks.map((card) => card.name));
      let name: string;
      if (explicitName !== undefined) {
        name = validateTaskName(explicitName);
        if (taken.has(name)) throw new Error(`Task ${name} already exists`);
      } else {
        const base = slugify(body.split("\n")[0] as string);
        if (!base)
          throw new Error("Cannot derive a task name from the text; pass an explicit name");
        name = base;
        for (let n = 2; taken.has(name); n += 1) {
          const suffix = `-${n}`;
          name = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
        }
      }
      const now = this.clock.now();
      const taskId = makeTaskId(now, name, this.taskSeq % 1000);
      this.taskSeq += 1;
      const entry = entryRole(this.pack);
      const note: Handoff = {
        id: randomUUID(),
        from: PHANTOM_SENDER,
        to: [entry],
        priority: 50,
        type: "note",
        task: name,
        taskId,
        approved: false,
        nonForwarding: false,
        createdAt: now.toISOString(),
        body,
      };
      // Files first: they are the source of truth, the board is rebuilt from them after a crash.
      await this.handoffs.inject(note);
      const card: TaskCard = {
        name,
        taskId,
        lane: entry,
        status: "queued",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        auditCount: 0,
      };
      await this.boardLock.run(async () => {
        this.board_.tasks.push(card);
        await this.boards.write(this.board_);
      });
      this.pump.wake();
      return { ...card };
    });
  }

  async answer(taskName: string, text: string): Promise<void> {
    const card = this.cardByName(taskName);
    const answer = text.trim();
    if (!answer) throw new Error("An answer needs text");
    await this.pump.answer(card.taskId, answer);
  }

  drain(): Promise<void> {
    return this.pump.drain();
  }

  /** Stop the pump and cancel running agent sessions. Never touches project directories. */
  async close(): Promise<void> {
    this.pump.halt();
    this.runner.cancelProject(this.name);
    this.gates?.cancelAll?.(this.dir);
    await this.pump.settled();
  }
}
