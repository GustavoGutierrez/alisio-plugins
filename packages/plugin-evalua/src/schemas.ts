import type { Question } from "@alisio/sdk";
import {
  type EvaluaState,
  type ExamDraft,
  type ExamProgress,
  type InterviewState,
  type PendingRound,
  type RoundId,
  roundIds,
} from "./types.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
export const controlPattern = /[\u0000-\u001f\u007f]/;

/** A trimmed, printable, single-line string of 1..max characters, or an Error naming the field. */
export function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const text = value.trim();
  if (text.length < 1 || text.length > max || controlPattern.test(text)) {
    throw new Error(`${field} must be 1 to ${max} printable characters`);
  }
  return text;
}

export const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function validateQuestions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined;
  for (const question of value) {
    if (!isRecord(question) || typeof question.id !== "string") return undefined;
    if (typeof question.question !== "string" || typeof question.header !== "string") {
      return undefined;
    }
    if (!Array.isArray(question.options) || question.options.length < 2) return undefined;
    for (const option of question.options) {
      if (!isRecord(option) || typeof option.value !== "string") return undefined;
      if (typeof option.label !== "string") return undefined;
    }
  }
  return value as Question[];
}

function validatePending(value: unknown): PendingRound | undefined {
  if (!isRecord(value)) return undefined;
  const round = value.round;
  if (typeof round !== "string" || !(roundIds as readonly string[]).includes(round)) {
    return undefined;
  }
  const questions = validateQuestions(value.questions);
  if (!questions) return undefined;
  return {
    round: round as RoundId,
    createdAt: isIso(value.createdAt) ? value.createdAt : new Date(0).toISOString(),
    questions,
  };
}

function validateInterview(value: unknown): InterviewState | undefined {
  if (!isRecord(value)) return undefined;
  const answers: Record<string, string> = {};
  if (isRecord(value.answers)) {
    for (const [key, entry] of Object.entries(value.answers)) {
      if (typeof entry === "string") answers[key] = entry;
    }
  }
  const completedRounds = Array.isArray(value.completedRounds)
    ? value.completedRounds.filter((round): round is RoundId =>
        (roundIds as readonly unknown[]).includes(round),
      )
    : [];
  const pending = validatePending(value.pending);
  return {
    flow: value.flow === "init" ? "init" : "new",
    edit: value.edit === true,
    answers,
    completedRounds,
    ...(pending ? { pending } : {}),
  };
}

function validateDraft(value: unknown): ExamDraft | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.title !== "string" || typeof value.theme !== "string") return undefined;
  if (typeof value.questionCount !== "number" || typeof value.slug !== "string") return undefined;
  return value as unknown as ExamDraft;
}

function validateExams(value: unknown): Record<string, ExamProgress> {
  const exams: Record<string, ExamProgress> = {};
  if (!isRecord(value)) return exams;
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.phase !== "string") continue;
    exams[id] = {
      phase: entry.phase,
      revision: Number.isInteger(entry.revision) ? (entry.revision as number) : 0,
      gates: isRecord(entry.gates) ? (entry.gates as ExamProgress["gates"]) : {},
    };
  }
  return exams;
}

/** Fields shared by the tolerant state reader; `root` is validated by the caller. */
export function stateFromRecord(raw: Record<string, unknown>, root: string): EvaluaState {
  const interview = validateInterview(raw.interview);
  const draft = validateDraft(raw.draft);
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    root,
    activeExamId: typeof raw.activeExamId === "string" ? raw.activeExamId : null,
    lastExamNumber:
      Number.isInteger(raw.lastExamNumber) && (raw.lastExamNumber as number) >= 0
        ? (raw.lastExamNumber as number)
        : 0,
    exams: validateExams(raw.exams),
    ...(interview ? { interview } : {}),
    ...(draft ? { draft } : {}),
    createdAt: isIso(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : now,
  };
}
