import { validateCommit, validateRole, validateTaskId, validateTaskName } from "./identifiers.js";

/** The phantom sender of a new task (spec 8.2). Never a real role. */
export const PHANTOM_SENDER = "(New Task)";
const PHANTOM_TOKEN = "new-task";

export type HandoffType = "git_handoff" | "note";

export interface Handoff {
  id: string;
  from: string;
  to: string[];
  priority: number;
  type: HandoffType;
  task: string;
  taskId: string;
  commit?: string;
  taskBaseCommit?: string;
  approved: boolean;
  nonForwarding: boolean;
  createdAt: string;
  enqueuedAt?: string;
  dequeuedAt?: string;
  completedAt?: string;
  body: string;
}

export type InboxBox = "new" | "in_process" | "completed";
export type HandoffLocation =
  | {
      kind: "outbox" | "sent" | "failed" | "audit_pending" | "pending_approval" | "join_pending";
      role: string;
    }
  | { kind: "inbox"; role: string; box: InboxBox };

export interface StoredHandoff {
  handoff: Handoff;
  location: HandoffLocation;
  fileName: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const optionalStamps = [
  ["enqueued_at", "enqueuedAt"],
  ["dequeued_at", "dequeuedAt"],
  ["completed_at", "completedAt"],
] as const;

const singleLine = (value: string, label: string): string => {
  if (/[\r\n\0]/.test(value)) throw new Error(`Invalid ${label}: line breaks are not allowed`);
  return value;
};

const validSender = (from: string): string => (from === PHANTOM_SENDER ? from : validateRole(from));

function isoStamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${label}: expected an ISO-8601 UTC timestamp`);
  }
  return value;
}

function checkHandoff(handoff: Handoff): void {
  if (!uuidPattern.test(handoff.id)) throw new Error("Invalid id: expected a UUID");
  validSender(handoff.from);
  if (handoff.to.length === 0) throw new Error("Invalid to: at least one recipient is required");
  for (const role of handoff.to) validateRole(role);
  if (!Number.isInteger(handoff.priority) || handoff.priority < 0 || handoff.priority > 99) {
    throw new Error("Invalid priority: expected an integer from 0 to 99");
  }
  if (handoff.type !== "git_handoff" && handoff.type !== "note") {
    throw new Error("Invalid type: expected git_handoff or note");
  }
  validateTaskName(handoff.task);
  validateTaskId(handoff.taskId);
  if (handoff.type === "git_handoff" && handoff.commit === undefined) {
    throw new Error("A git_handoff needs a commit");
  }
  if (handoff.commit !== undefined) validateCommit(handoff.commit);
  if (handoff.taskBaseCommit !== undefined) validateCommit(handoff.taskBaseCommit);
  isoStamp(handoff.createdAt, "created_at");
  for (const [, field] of optionalStamps) {
    const value = handoff[field];
    if (value !== undefined) isoStamp(value, field);
  }
}

/** Header block, one blank line, then the generated body (same shape as upstream, human-readable). */
export function serializeHandoff(handoff: Handoff): string {
  checkHandoff(handoff);
  const lines = [
    `id: ${handoff.id}`,
    `from: ${singleLine(handoff.from, "from")}`,
    `to: ${handoff.to.map((role) => singleLine(role, "to")).join(",")}`,
    `priority: ${handoff.priority}`,
    `type: ${handoff.type}`,
    `task: ${singleLine(handoff.task, "task")}`,
    `task_id: ${handoff.taskId}`,
  ];
  if (handoff.commit !== undefined) lines.push(`commit: ${handoff.commit}`);
  if (handoff.taskBaseCommit !== undefined)
    lines.push(`task_base_commit: ${handoff.taskBaseCommit}`);
  lines.push(`approved: ${handoff.approved}`, `non-forwarding: ${handoff.nonForwarding}`);
  lines.push(`created_at: ${handoff.createdAt}`);
  for (const [key, field] of optionalStamps) {
    const value = handoff[field];
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  return `${lines.join("\n")}\n\n${handoff.body}`;
}

const headerKeys = [
  "id",
  "from",
  "to",
  "priority",
  "type",
  "task",
  "task_id",
  "commit",
  "task_base_commit",
  "approved",
  "non-forwarding",
  "created_at",
  "enqueued_at",
  "dequeued_at",
  "completed_at",
];
const requiredKeys = [
  "id",
  "from",
  "to",
  "priority",
  "type",
  "task",
  "task_id",
  "approved",
  "non-forwarding",
  "created_at",
];

function bool(value: string, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${label}: expected true or false`);
}

/** Strict parse. Handoff files are never trusted without revalidation on load. */
export function parseHandoff(text: string): Handoff {
  const normalized = text.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  if (split < 0) throw new Error("Malformed handoff: missing the blank line after the header");
  const header = new Map<string, string>();
  for (const line of normalized.slice(0, split).split("\n")) {
    const match = /^([a-z_-]+): ?(.*)$/.exec(line);
    if (!match)
      throw new Error(`Malformed handoff header line: ${JSON.stringify(line.slice(0, 40))}`);
    const key = match[1] as string;
    if (!headerKeys.includes(key)) throw new Error(`Unknown header "${key}"`);
    if (header.has(key)) throw new Error(`Duplicate header "${key}"`);
    header.set(key, match[2] as string);
  }
  for (const key of requiredKeys) {
    if (!header.has(key)) throw new Error(`Missing header "${key}"`);
  }
  const get = (key: string) => header.get(key) as string;
  const priority = Number(get("priority"));
  if (!/^\d{1,2}$/.test(get("priority"))) throw new Error("Invalid priority: expected an integer");
  const type = get("type");
  if (type !== "git_handoff" && type !== "note") throw new Error("Invalid type in handoff header");
  const handoff: Handoff = {
    id: get("id"),
    from: get("from"),
    to: get("to")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
    priority,
    type,
    task: get("task"),
    taskId: get("task_id"),
    approved: bool(get("approved"), "approved"),
    nonForwarding: bool(get("non-forwarding"), "non-forwarding"),
    createdAt: get("created_at"),
    body: normalized.slice(split + 2),
  };
  if (header.has("commit")) handoff.commit = get("commit");
  if (header.has("task_base_commit")) handoff.taskBaseCommit = get("task_base_commit");
  for (const [key, field] of optionalStamps) {
    if (header.has(key)) handoff[field] = get(key);
  }
  checkHandoff(handoff);
  return handoff;
}

export interface HandoffNameParts {
  priority: number;
  createdAt: string;
  seq: number;
  from: string;
  to: string[];
}

const compactStamp = (iso: string): string => `${iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

/** `<NN>_<UTC>_<seq>_from_<sender>_to_<r1_r2>.handoff` */
export function handoffFileName(parts: HandoffNameParts): string {
  const sender = parts.from === PHANTOM_SENDER ? PHANTOM_TOKEN : validateRole(parts.from);
  for (const role of parts.to) validateRole(role);
  return `${String(parts.priority).padStart(2, "0")}_${compactStamp(isoStamp(parts.createdAt, "created_at"))}_${String(parts.seq).padStart(4, "0")}_from_${sender}_to_${parts.to.join("_")}.handoff`;
}

export interface ParsedHandoffName {
  priority: number;
  stamp: string;
  seq: number;
  from: string;
  to: string[];
}

export function parseHandoffFileName(name: string): ParsedHandoffName | undefined {
  const match =
    /^(\d{2})_(\d{8}T\d{6}Z)_(\d{4,})_from_([a-z][a-z0-9-]{0,23})_to_([a-z][a-z0-9-]{0,23}(?:_[a-z][a-z0-9-]{0,23})*)\.handoff$/.exec(
      name,
    );
  if (!match) return undefined;
  const sender = match[4] as string;
  return {
    priority: Number(match[1]),
    stamp: match[2] as string,
    seq: Number(match[3]),
    from: sender === PHANTOM_TOKEN ? PHANTOM_SENDER : sender,
    to: (match[5] as string).split("_"),
  };
}
