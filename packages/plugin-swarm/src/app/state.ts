import type { AttentionItem } from "../domain/attention.js";
import { roleIds } from "../domain/pack.js";
import type { TaskCard, TaskStatus } from "../domain/task.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import type { Clock } from "../ports/clock.js";
import type { ActivityKind } from "../ports/notifier.js";
import type { ProjectSnapshot } from "../status.js";
import type { PackInfo } from "./forge.js";
import type { ProjectRuntime } from "./project.js";

export type RoleState = "live" | "idle" | "none";

export interface CardView {
  name: string;
  lane: string;
  status: TaskStatus;
  auditCount: number;
  snippet: string;
  ageSeconds: number;
  /** Highlighted on the board while the coordinator merges the work. */
  merging: boolean;
}

export interface QueueRow {
  role: string;
  task?: string;
  state: RoleState;
  /** 0 to 6: runs in the last ten minutes, capped. */
  activity: number;
  ageSeconds?: number;
  /** The host child session of the role, so the operator can open it in Alisio. */
  sessionId?: string;
}

export interface ProjectView {
  name: string;
  pack: string;
  open: boolean;
  running: boolean;
  roles: string[];
  columns: string[];
  approvalAfter?: string;
  tasks: CardView[];
  queue: QueueRow[];
}

/** One recent event (handoff, merge, gate result, bounce, approval wait) for the activity log. */
export interface ActivityEntry {
  at: string;
  project: string;
  kind: ActivityKind;
  role: string;
  task: string;
  message: string;
}

/** The `GET /api/state` payload (spec 9). It never contains filesystem paths. */
export interface DashboardState {
  schemaVersion: 1;
  generatedAt: string;
  initialised: boolean;
  /** Every role, the Lieutenant included, runs as an Alisio child session. */
  runner: "Alisio";
  budget: { total: number; limit: number | undefined; exceeded: boolean };
  packs: PackInfo[];
  projects: ProjectView[];
  attention: AttentionItem[];
  /** Recent events, oldest first. In memory: it starts empty after a restart. */
  activity: ActivityEntry[];
}

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "Queued",
  working: "Working",
  waiting_approval: "Waiting for approval",
  rejected: "Rejected: needs your decision",
  merging: "Merging",
  clarifying: "Needs an answer",
  blocked: "Blocked: needs your decision",
  done: "Done",
};

const SNIPPET_MAX = 160;

const compact = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
};

const ageOf = (iso: string, now: number): number =>
  Math.max(0, Math.round((now - Date.parse(iso)) / 1000));

export const emptyState = (generatedAt: string, initialised: boolean): DashboardState => ({
  schemaVersion: 1,
  generatedAt,
  initialised,
  runner: "Alisio",
  budget: { total: 0, limit: undefined, exceeded: false },
  packs: [],
  projects: [],
  attention: [],
  activity: [],
});

async function queueFor(
  runtime: ProjectRuntime,
  runner: AgentRunner,
  now: number,
): Promise<QueueRow[]> {
  const tasks = runtime.board().tasks;
  const active = runtime.activeRoles();
  const rows: QueueRow[] = [];
  for (const role of roleIds(runtime.pack)) {
    const view = runner.inspect?.(`${runtime.name}/${role}`);
    const taskName = active.get(role);
    const card: TaskCard | undefined = taskName
      ? tasks.find((candidate) => candidate.name === taskName)
      : tasks.find((candidate) => candidate.lane === role && candidate.status !== "done");
    const live = active.has(role) || view?.live === true;
    const mail = (await runtime.handoffs.pending(role).catch(() => 0)) > 0;
    const state: RoleState = live ? "live" : view || card || mail ? "idle" : "none";
    const recent = view?.recentRuns ?? 0;
    rows.push({
      role,
      ...(card ? { task: card.name, ageSeconds: ageOf(card.updatedAt, now) } : {}),
      state,
      ...(view?.sessionId ? { sessionId: view.sessionId } : {}),
      activity: Math.min(6, live ? Math.max(1, recent) : recent),
    });
  }
  return rows;
}

function cardView(
  card: TaskCard,
  attention: AttentionItem[],
  runner: AgentRunner,
  project: string,
  now: number,
): CardView {
  const item = attention.find((candidate) => candidate.task === card.name);
  let snippet = STATUS_TEXT[card.status];
  if (item?.detail) snippet = compact(item.detail);
  else if (card.status === "working") {
    const reply = runner
      .inspect?.(`${project}/${card.lane}`)
      ?.tail.filter((line) => line.kind === "reply")
      .at(-1);
    if (reply) snippet = compact(reply.text);
  }
  return {
    name: card.name,
    lane: card.lane,
    status: card.status,
    auditCount: card.auditCount,
    snippet,
    ageSeconds: ageOf(card.updatedAt, now),
    merging: card.status === "merging",
  };
}

export async function buildProjectViews(
  snapshots: ProjectSnapshot[],
  runtimes: (name: string) => ProjectRuntime | undefined,
  runner: AgentRunner,
  clock: Clock,
): Promise<ProjectView[]> {
  const now = clock.now().getTime();
  const out: ProjectView[] = [];
  for (const snapshot of snapshots) {
    const roles = snapshot.pack ? roleIds(snapshot.pack) : [];
    const runtime = runtimes(snapshot.name);
    out.push({
      name: snapshot.name,
      pack: snapshot.pack?.name ?? "unknown",
      open: snapshot.open,
      running: snapshot.running,
      roles,
      columns: [...roles, "done"],
      ...(snapshot.pack?.approval ? { approvalAfter: snapshot.pack.approval.after } : {}),
      tasks: (snapshot.board?.tasks ?? []).map((card) =>
        cardView(card, snapshot.attention, runner, snapshot.name, now),
      ),
      queue: runtime ? await queueFor(runtime, runner, now) : [],
    });
  }
  return out;
}
