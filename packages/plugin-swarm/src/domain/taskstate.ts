import {
  assertRelativePath,
  validateCommit,
  validateRole,
  validateTaskId,
  validateTaskName,
} from "./identifiers.js";

/** Why a task waits for a human. Persisted so a restart keeps the question. */
export const holdKinds = ["clarifying", "blocked", "gate-failed"] as const;
export type HoldKind = (typeof holdKinds)[number];

export interface Hold {
  kind: HoldKind;
  role: string;
  text: string;
  createdAt: string;
}

export interface ApprovalComment {
  /** Document path relative to the project root. */
  doc: string;
  text: string;
  createdAt: string;
}

/** Everything the coordinator remembers about one task besides the handoff files (schema-versioned). */
export interface TaskState {
  schemaVersion: 1;
  taskId: string;
  task: string;
  /** Head of each role's working directory when it first started the task: where Retry restores to. */
  bases: Record<string, string>;
  hold?: Hold | undefined;
  /** An operator answer waiting for the role to restart after a restart of the process. */
  answer?: { question: string; text: string } | undefined;
  comments: ApprovalComment[];
  /** Bounces per role (gate failures and QA rejections), bounded by `limits.maxBounces`. */
  bounces: Record<string, number>;
  rejections: number;
}

export const MAX_HOLD_TEXT = 4000;

export const emptyTaskState = (taskId: string, task: string): TaskState => ({
  schemaVersion: 1,
  taskId,
  task,
  bases: {},
  comments: [],
  bounces: {},
  rejections: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function validateHold(raw: unknown): Hold {
  if (!isRecord(raw)) throw new Error("Invalid hold: expected an object");
  if (!holdKinds.includes(raw.kind as HoldKind)) throw new Error("Invalid hold kind");
  validateRole(raw.role as string);
  if (typeof raw.text !== "string" || raw.text.length > MAX_HOLD_TEXT) {
    throw new Error("Invalid hold text");
  }
  if (!isIso(raw.createdAt)) throw new Error("Invalid hold timestamp");
  return {
    kind: raw.kind as HoldKind,
    role: raw.role as string,
    text: raw.text,
    createdAt: raw.createdAt,
  };
}

export function validateTaskState(value: unknown): TaskState {
  if (!isRecord(value)) throw new Error("Invalid task state: expected an object");
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported task state schemaVersion (expected 1)");
  const state: TaskState = {
    schemaVersion: 1,
    taskId: validateTaskId(value.taskId as string),
    task: validateTaskName(value.task as string),
    bases: {},
    comments: [],
    bounces: {},
    rejections: 0,
  };
  if (!isRecord(value.bases)) throw new Error("Invalid bases");
  for (const [role, commit] of Object.entries(value.bases)) {
    validateRole(role);
    state.bases[role] = validateCommit(commit as string);
  }
  if (value.answer !== undefined) {
    const answer = value.answer;
    if (
      !isRecord(answer) ||
      typeof answer.question !== "string" ||
      typeof answer.text !== "string" ||
      answer.text.length > MAX_HOLD_TEXT ||
      answer.question.length > MAX_HOLD_TEXT
    ) {
      throw new Error("Invalid pending answer");
    }
    state.answer = { question: answer.question, text: answer.text };
  }
  if (value.hold !== undefined) state.hold = validateHold(value.hold);
  if (!Array.isArray(value.comments)) throw new Error("Invalid comments");
  state.comments = value.comments.map((raw): ApprovalComment => {
    if (
      !isRecord(raw) ||
      typeof raw.text !== "string" ||
      !raw.text.trim() ||
      !isIso(raw.createdAt)
    ) {
      throw new Error("Invalid approval comment");
    }
    if (raw.text.length > MAX_HOLD_TEXT) throw new Error("Approval comment is too long");
    return {
      doc: assertRelativePath(raw.doc as string),
      text: raw.text,
      createdAt: raw.createdAt,
    };
  });
  if (!isRecord(value.bounces)) throw new Error("Invalid bounces");
  for (const [role, count] of Object.entries(value.bounces)) {
    validateRole(role);
    if (!Number.isInteger(count) || (count as number) < 0) throw new Error("Invalid bounce count");
    state.bounces[role] = count as number;
  }
  if (!Number.isInteger(value.rejections) || (value.rejections as number) < 0) {
    throw new Error("Invalid rejection count");
  }
  state.rejections = value.rejections as number;
  return state;
}
