import {
  type HandoffLocation,
  PHANTOM_SENDER,
  parseHandoffFileName,
  type StoredHandoff,
} from "./handoff.js";
import { validateRole, validateTaskId, validateTaskName } from "./identifiers.js";
import { type Pack, roleIds } from "./pack.js";

export const taskStatuses = [
  "queued",
  "working",
  "waiting_approval",
  "rejected",
  "merging",
  "clarifying",
  "blocked",
  "done",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export interface TaskCard {
  name: string;
  taskId: string;
  /** A pack role id, or `done`. */
  lane: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  auditCount: number;
}

export interface Board {
  schemaVersion: 1;
  tasks: TaskCard[];
}

/** Statuses only the coordinator knows: handoff files cannot express them. */
const boardOnlyStatuses: readonly TaskStatus[] = ["clarifying", "blocked", "rejected"];

export const emptyBoard = (): Board => ({ schemaVersion: 1, tasks: [] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

export function validateBoard(value: unknown): Board {
  if (!isRecord(value)) throw new Error("Invalid board: expected an object");
  if (value.schemaVersion !== 1) throw new Error("Unsupported board schemaVersion (expected 1)");
  if (!Array.isArray(value.tasks)) throw new Error("Invalid board: tasks must be an array");
  const seen = new Set<string>();
  const tasks = value.tasks.map((raw): TaskCard => {
    if (!isRecord(raw)) throw new Error("Invalid task card: expected an object");
    validateTaskName(raw.name as string);
    validateTaskId(raw.taskId as string);
    if (raw.lane !== "done") {
      try {
        validateRole(raw.lane as string);
      } catch {
        throw new Error("Invalid lane on task card");
      }
    }
    if (!taskStatuses.includes(raw.status as TaskStatus)) {
      throw new Error(`Invalid status on task card: ${String(raw.status)}`);
    }
    if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) {
      throw new Error("Invalid timestamps on task card");
    }
    if (!Number.isInteger(raw.auditCount) || (raw.auditCount as number) < 0) {
      throw new Error("Invalid auditCount on task card");
    }
    if (seen.has(raw.taskId as string)) throw new Error("Duplicate task id on board");
    seen.add(raw.taskId as string);
    return {
      name: raw.name as string,
      taskId: raw.taskId as string,
      lane: raw.lane as string,
      status: raw.status as TaskStatus,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      auditCount: raw.auditCount as number,
    };
  });
  return { schemaVersion: 1, tasks };
}

const stampOf = (record: StoredHandoff): string =>
  record.handoff.completedAt ??
  record.handoff.dequeuedAt ??
  record.handoff.enqueuedAt ??
  record.handoff.createdAt;

const seqOf = (record: StoredHandoff): number => parseHandoffFileName(record.fileName)?.seq ?? 0;

const byAge = (a: StoredHandoff, b: StoredHandoff): number =>
  a.handoff.createdAt.localeCompare(b.handoff.createdAt) || seqOf(a) - seqOf(b);

const inFlight = (kind: HandoffLocation["kind"]): boolean =>
  kind === "audit_pending" ||
  kind === "pending_approval" ||
  kind === "join_pending" ||
  kind === "failed";

/**
 * Rebuild the board from handoff files (the source of truth, AD-11). Board-only statuses that files
 * cannot express (clarifying, blocked, rejected) survive from `previous` while the lane is unchanged.
 */
export function rebuildBoard(pack: Pack, records: StoredHandoff[], previous?: Board): Board {
  const roles = roleIds(pack);
  const last = roles.at(-1) as string;
  const byTask = new Map<string, StoredHandoff[]>();
  for (const record of records) {
    const list = byTask.get(record.handoff.taskId) ?? [];
    list.push(record);
    byTask.set(record.handoff.taskId, list);
  }
  const cards: TaskCard[] = [];
  for (const [taskId, list] of byTask) {
    list.sort(byAge);
    const first = list[0] as StoredHandoff;
    const released = list.filter(
      (r) =>
        r.handoff.type === "git_handoff" &&
        r.handoff.from !== PHANTOM_SENDER &&
        !inFlight(r.location.kind),
    );
    const auditCount = new Set(released.map((r) => `${r.handoff.from}:${r.handoff.commit}`)).size;
    const finished = released.some((r) => r.handoff.from === last);
    const forwarding = list.filter(
      (r) =>
        (!r.handoff.nonForwarding || inFlight(r.location.kind)) &&
        r.handoff.to.every((role) => roles.includes(role)),
    );
    const latest = forwarding.at(-1);
    let lane: string;
    let status: TaskStatus;
    if (finished) {
      lane = "done";
      status = "done";
    } else if (!latest) {
      // Only parked terminal/merge-only copies exist: the owner is the sender still auditing.
      const parked = list.filter((r) => inFlight(r.location.kind)).at(-1) ?? first;
      lane = roles.includes(parked.handoff.from) ? parked.handoff.from : (roles[0] as string);
      status = "working";
    } else {
      const location = latest.location;
      const sender = latest.handoff.from;
      const target = latest.handoff.to[0] as string;
      if (location.kind === "audit_pending" || location.kind === "join_pending") {
        lane = roles.includes(sender) ? sender : target;
        status = "working";
      } else if (location.kind === "pending_approval") {
        lane = roles.includes(sender) ? sender : target;
        status = "waiting_approval";
      } else if (location.kind === "failed") {
        lane = roles.includes(sender) ? sender : target;
        status = "blocked";
      } else {
        lane = target;
        const copy = list.find(
          (r) =>
            r.handoff.id === latest.handoff.id &&
            r.location.kind === "inbox" &&
            r.location.role === target,
        );
        const box = copy?.location.kind === "inbox" ? copy.location.box : "new";
        status = box === "new" ? "queued" : "working";
      }
    }
    const before = previous?.tasks.find((card) => card.taskId === taskId);
    if (before && before.lane === lane && boardOnlyStatuses.includes(before.status) && !finished) {
      status = before.status;
    }
    const newest = list.reduce(
      (acc, r) => (stampOf(r) > acc ? stampOf(r) : acc),
      first.handoff.createdAt,
    );
    cards.push({
      name: first.handoff.task,
      taskId,
      lane,
      status,
      createdAt: first.handoff.createdAt,
      updatedAt: before && before.updatedAt > newest ? before.updatedAt : newest,
      auditCount: Math.max(auditCount, before?.lane === lane ? before.auditCount : 0),
    });
  }
  cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
  return { schemaVersion: 1, tasks: cards };
}
