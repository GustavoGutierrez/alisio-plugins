import type { AskQuestionsRequest, AskQuestionsResult } from "@alisio/sdk";
import type { AttentionItem } from "../domain/attention.js";
import { validateProjectName, validateRole, validateTaskName } from "../domain/identifiers.js";
import { type GateName, gateNames, type Pack } from "../domain/pack.js";
import type { AgentRunner, TailEntry } from "../ports/agent-runner.js";
import { type Clock, systemClock } from "../ports/clock.js";
import type { GateReport, GateRunner } from "../ports/gate-runner.js";
import type { Isolation } from "../ports/isolation.js";
import type { Notifier } from "../ports/notifier.js";
import { agentForRole } from "../resources.js";
import { renderStatus } from "../status.js";
import { type ChatMessage, ChatStore } from "./chat-store.js";
import { buildDocuments, type DocumentsView } from "./documents.js";
import { Forge, type NewProjectInput, type PackInfo } from "./forge.js";
import type { RejectAction } from "./operator.js";
import type { ProjectRuntime } from "./project.js";
import {
  type ActivityEntry,
  buildProjectViews,
  type DashboardState,
  emptyState,
  type RoleState,
} from "./state.js";

/** The slice of `api.ui` the services use; absent or non-interactive means headless. */
export interface UiPort {
  interactive(): boolean;
  askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
}

export interface ServicesDeps {
  isolation: Isolation;
  runner: AgentRunner;
  clock?: Clock;
  notifier?: Notifier;
  gates?: GateRunner;
  cloneUrl?: (repo: string) => string;
  maxConcurrent?: number;
  tokenBudget?: number;
  autoStart?: boolean;
  ui?: UiPort;
}

export interface BudgetStatus {
  total: number;
  limit: number | undefined;
  exceeded: boolean;
}

const MAX_CHAT_REPLY = 8000;
const MAX_ACTIVITY = 100;
const SHOWN_ACTIVITY = 50;
export const TEARDOWN_CONFIRMATION = "TEARDOWN";

/**
 * Application services (AD-10): the one implementation behind the `/swarm:*` commands, the tools
 * and the dashboard. Front ends only parse input and render output; every decision goes through
 * these methods. Names are validated identifiers at every boundary.
 */
export class SwarmServices {
  private readonly forges = new Map<string, Forge>();
  private readonly activity = new Map<string, ActivityEntry[]>();
  private readonly teardowns = new Set<() => void | Promise<void>>();

  constructor(private readonly deps: ServicesDeps) {}

  forgeFor(workspace: string): Forge {
    let forge = this.forges.get(workspace);
    if (!forge) {
      forge = new Forge({
        workspace,
        isolation: this.deps.isolation,
        runner: this.deps.runner,
        ...(this.deps.maxConcurrent !== undefined
          ? { maxConcurrent: this.deps.maxConcurrent }
          : {}),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
        notifier: {
          notify: (event) => {
            if (event.type === "activity") this.record(workspace, event);
            this.deps.notifier?.notify(event);
          },
        },
        ...(this.deps.autoStart !== undefined ? { autoStart: this.deps.autoStart } : {}),
        ...(this.deps.cloneUrl ? { cloneUrl: this.deps.cloneUrl } : {}),
        ...(this.deps.gates ? { gates: this.deps.gates } : {}),
        ...(this.deps.tokenBudget !== undefined ? { tokenBudget: this.deps.tokenBudget } : {}),
      });
      this.forges.set(workspace, forge);
    }
    return forge;
  }

  private record(workspace: string, event: ActivityEntry & { type: "activity" }): void {
    const { type: _type, ...entry } = event;
    const list = this.activity.get(workspace) ?? [];
    list.push(entry);
    if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY);
    this.activity.set(workspace, list);
  }

  /** The running runtime of an open project, with a helpful error otherwise. */
  async runtimeOf(workspace: string, project: string): Promise<ProjectRuntime> {
    validateProjectName(project);
    const forge = this.forgeFor(workspace);
    const runtime = forge.runtime(project);
    if (runtime) return runtime;
    const known = (await forge.listProjects()).some((p) => p.name === project);
    throw new Error(
      known
        ? `Project ${project} is not open; run /swarm:project open ${project}`
        : `Unknown project: ${project}`,
    );
  }

  async openProjects(workspace: string): Promise<string[]> {
    return (await this.forgeFor(workspace).listProjects())
      .filter((p) => p.running)
      .map((p) => p.name);
  }

  // ---- projects ----

  async newProject(workspace: string, input: NewProjectInput): Promise<ProjectRuntime> {
    return this.forgeFor(workspace).newProject(input);
  }

  async openProject(workspace: string, project: string): Promise<ProjectRuntime> {
    return this.forgeFor(workspace).openProject(project);
  }

  async closeProject(workspace: string, project: string): Promise<void> {
    await this.forgeFor(workspace).closeProject(project);
  }

  async listProjects(workspace: string) {
    return this.forgeFor(workspace).listProjects();
  }

  async listPacks(workspace: string): Promise<PackInfo[]> {
    return this.forgeFor(workspace).listPacks();
  }

  /** A pack definition (workspace pack shadows a shipped one) as JSON, for the editable pack in the UI. */
  async packDefinition(workspace: string, name: string): Promise<Pack> {
    return this.forgeFor(workspace).loadPack(name);
  }

  /** The mission text of a known project, open or closed. */
  async mission(workspace: string, project: string): Promise<string> {
    return this.forgeFor(workspace).mission(project);
  }

  // ---- tasks ----

  async createTask(workspace: string, project: string, text: string, name?: string) {
    return (await this.runtimeOf(workspace, project)).newTask(text, name);
  }

  async approve(workspace: string, project: string, task: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).approve(task);
  }

  async reject(
    workspace: string,
    project: string,
    task: string,
    action: RejectAction,
    comments?: string,
  ): Promise<void> {
    await (await this.runtimeOf(workspace, project)).reject(task, action, comments);
  }

  async answer(workspace: string, project: string, task: string, text: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).answer(task, text);
  }

  async retryTask(workspace: string, project: string, task: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).retryTask(task);
  }

  async acceptTask(workspace: string, project: string, task: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).acceptTask(task);
  }

  async deleteTask(workspace: string, project: string, task: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).deleteTask(task);
  }

  async addComment(
    workspace: string,
    project: string,
    task: string,
    doc: string,
    text: string,
  ): Promise<void> {
    await (await this.runtimeOf(workspace, project)).addComment(task, doc, text);
  }

  async clearComments(workspace: string, project: string, task: string): Promise<void> {
    await (await this.runtimeOf(workspace, project)).clearComments(task);
  }

  /** Items that need a human across every running project, oldest first. */
  async attention(workspace: string, project?: string): Promise<AttentionItem[]> {
    const names = project !== undefined ? [project] : await this.openProjects(workspace);
    const items: AttentionItem[] = [];
    for (const name of names) items.push(...(await this.runtimeOf(workspace, name)).attention());
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---- Lieutenant chat ----

  /** One operator message to the read-only Lieutenant child session; returns its plain-text reply. */
  async chat(workspace: string, project: string, message: string): Promise<string> {
    const text = message.trim();
    if (!text) throw new Error("A chat message needs text");
    if (text.length > 4000) throw new Error("The chat message is too long");
    const runtime = await this.runtimeOf(workspace, project);
    const [snapshot] = await this.forgeFor(workspace).snapshot(project);
    const board = snapshot ? renderStatus([snapshot]).text : "No board yet.";
    const agent = agentForRole("lieutenant") as string;
    const result = await this.deps.runner.run({
      sessionKey: `${project}/lieutenant`,
      project,
      role: "lieutenant",
      agent,
      workdir: runtime.dir,
      prompt: [
        `You are talking with the operator of the swarm project ${project}.`,
        "Reply in plain text. Do not implement anything; point the operator at tasks instead.",
        "",
        "Current board:",
        board,
        "",
        `Operator: ${text}`,
      ].join("\n"),
    });
    if (result.status === "cancelled") throw new Error("The Lieutenant chat was cancelled");
    if (result.status === "failed") {
      throw new Error(`The Lieutenant could not answer: ${result.error ?? "unknown error"}`);
    }
    const reply = result.text.trim();
    const answer = reply ? reply.slice(0, MAX_CHAT_REPLY) : "The Lieutenant sent no reply.";
    const at = (this.deps.clock ?? systemClock).now().toISOString();
    await new ChatStore(runtime.dir)
      .append({ from: "operator", text, at }, { from: "lieutenant", text: answer, at })
      .catch(() => undefined);
    return answer;
  }

  /** The persisted, bounded Lieutenant conversation of a project. */
  async chatHistory(workspace: string, project: string): Promise<ChatMessage[]> {
    return new ChatStore((await this.runtimeOf(workspace, project)).dir).read();
  }

  // ---- read views for the dashboard ----

  /** Task documents, the diff from the gate role's base to the held commit and their comments. */
  async documents(workspace: string, project: string, task: string): Promise<DocumentsView> {
    validateTaskName(task);
    return buildDocuments(await this.runtimeOf(workspace, project), task);
  }

  /** Child session id and the recorded activity tail of one role (the SDK has no transcript API). */
  async agentTail(
    workspace: string,
    project: string,
    role: string,
  ): Promise<{
    role: string;
    runner: "Alisio";
    sessionId?: string;
    state: RoleState;
    tail: TailEntry[];
  }> {
    validateRole(role);
    const runtime = await this.runtimeOf(workspace, project);
    if (!runtime.pack.roles.some((candidate) => candidate.id === role)) {
      throw new Error(`Unknown role: ${role}`);
    }
    const view = this.deps.runner.inspect?.(`${project}/${role}`);
    const live = runtime.activeRoles().has(role) || view?.live === true;
    return {
      role,
      runner: "Alisio",
      ...(view?.sessionId ? { sessionId: view.sessionId } : {}),
      state: live ? "live" : view ? "idle" : "none",
      tail: view?.tail ?? [],
    };
  }

  /** The `GET /api/state` snapshot: board, attention and work queue, built from `Forge.snapshot`. */
  async state(workspace: string): Promise<DashboardState> {
    const forge = this.forgeFor(workspace);
    const clock = this.deps.clock ?? systemClock;
    const generatedAt = clock.now().toISOString();
    if (!(await forge.isInitialised())) return emptyState(generatedAt, false);
    const snapshots = await forge.snapshot();
    return {
      schemaVersion: 1,
      generatedAt,
      initialised: true,
      runner: "Alisio",
      budget: forge.budget(),
      packs: await forge.listPacks(),
      projects: await buildProjectViews(
        snapshots,
        (name) => forge.runtime(name),
        this.deps.runner,
        clock,
      ),
      attention: await this.attention(workspace),
      activity: (this.activity.get(workspace) ?? []).slice(-SHOWN_ACTIVITY),
    };
  }

  // ---- run control ----

  async stopProject(workspace: string, project: string): Promise<void> {
    await this.forgeFor(workspace).stopProject(project);
  }

  /** Drain a project in the foreground within a bound (the fallback when background promises die). */
  async runProject(
    workspace: string,
    project: string,
    seconds: number,
  ): Promise<{ finished: boolean }> {
    const runtime = await this.runtimeOf(workspace, project);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), seconds * 1000);
    });
    try {
      const finished = await Promise.race([runtime.drain().then(() => true as const), timeout]);
      return { finished };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- budget ----

  budget(workspace: string): BudgetStatus {
    return this.forgeFor(workspace).budget();
  }

  async raiseBudget(workspace: string, extra: number): Promise<BudgetStatus> {
    const forge = this.forgeFor(workspace);
    await forge.raiseBudget(extra);
    return forge.budget();
  }

  // ---- gates ----

  /** Run one named gate for a role (the `swarm_gate_run` tool). */
  async gateRun(
    workspace: string,
    input: { project: string; role: string; gate: string; task?: string },
  ): Promise<GateReport> {
    const gates = this.deps.gates;
    if (!gates) throw new Error("Quality gates are not available in this session");
    if (!(gateNames as readonly string[]).includes(input.gate)) {
      throw new Error(`Unknown gate: ${input.gate}. Use one of: ${gateNames.join(", ")}`);
    }
    validateRole(input.role);
    const runtime = await this.runtimeOf(workspace, input.project);
    if (!runtime.pack.roles.some((role) => role.id === input.role)) {
      throw new Error(`Unknown role: ${input.role}`);
    }
    let since: string | undefined;
    if (input.task !== undefined) {
      const card = runtime.cardByName(input.task);
      since = (await runtime.state.get(card.taskId))?.bases[input.role];
    }
    return gates.run({
      project: input.project,
      task: input.task ?? "-",
      role: input.role,
      gate: input.gate as GateName,
      workdir: runtime.workdir(input.role),
      toolchain: runtime.pack.toolchain,
      thresholds: runtime.pack.thresholds,
      ...(since ? { since } : {}),
    });
  }

  // ---- interactive gates ----

  /** `ui.askQuestions` when an interactive UI is bound; `undefined` means "use the command form". */
  async ask(request: AskQuestionsRequest): Promise<AskQuestionsResult | undefined> {
    const ui = this.deps.ui;
    if (!ui?.interactive()) return undefined;
    try {
      return await ui.askQuestions(request);
    } catch {
      return undefined;
    }
  }

  // ---- lifecycle ----

  /** Register cleanup run on teardown and dispose (the dashboard server registers here). */
  onTeardown(cleanup: () => void | Promise<void>): () => void {
    this.teardowns.add(cleanup);
    return () => {
      this.teardowns.delete(cleanup);
    };
  }

  /** Stop every project, cancel agents and gates and run the registered cleanups. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.forges.values()].map((forge) => forge.stopAll()));
    this.deps.runner.cancelAll?.();
    this.deps.gates?.cancelAll?.();
    const cleanups = [...this.teardowns];
    this.teardowns.clear();
    await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
  }

  async teardown(confirm: string | undefined): Promise<void> {
    if (confirm !== TEARDOWN_CONFIRMATION) {
      throw new Error(`Teardown needs the exact confirmation: --confirm ${TEARDOWN_CONFIRMATION}`);
    }
    await this.shutdown();
  }
}
