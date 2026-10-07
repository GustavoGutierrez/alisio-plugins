import type { Question } from "@alisio/sdk";

export const levels = ["basico", "intermedio", "avanzado", "genio"] as const;
export type Level = (typeof levels)[number];

export const itemTypes = ["single_choice", "multiple_choice", "open", "practice"] as const;
export type ItemType = (typeof itemTypes)[number];

export const cognitives = ["recall", "apply", "reason"] as const;
export type Cognitive = (typeof cognitives)[number];

export const roundIds = ["profile", "1", "2", "2b", "3"] as const;
export type RoundId = (typeof roundIds)[number];

export type Paper = "letter" | "a4";
export type Instrument = "pencil" | "pen" | "any";
export type ClosingKind = "none" | "quote" | "bible";

/** `teacher.yaml` (spec 5.1). */
export interface TeacherProfile {
  schemaVersion: 1;
  teacherName: string;
  institution: string;
  /** Workspace-root relative, always under `assets/`. */
  logo?: string;
  subject: string;
  language: string;
  paper: Paper;
}

export interface CatalogOption {
  value: string;
  label: string;
}

/**
 * Where the interview learns what the knowledge base offers. Phase 1 ships an empty catalog;
 * the knowledge base (Phase 2) provides the real one without changing the interview.
 */
export interface TopicCatalog {
  suggestions(grade?: string): CatalogOption[];
  packs(): CatalogOption[];
  /** The pack a topic answer belongs to, or undefined when it is ambiguous or unknown. */
  resolvePack(topic: string): string | undefined;
}

export interface PendingRound {
  round: RoundId;
  createdAt: string;
  questions: Question[];
}

export type InterviewFlow = "init" | "new";

export interface InterviewState {
  flow: InterviewFlow;
  /** `init --edit`: current values are offered as the recommended answer. */
  edit: boolean;
  answers: Record<string, string>;
  completedRounds: RoundId[];
  pending?: PendingRound;
}

/** The exam spec as gathered by the interview, held in state until Gate A (spec 5.2, 7.4). */
export interface ExamDraft {
  schemaVersion: 1;
  title: string;
  theme: string;
  grade: string;
  level: Level;
  packs: string[];
  topics: string[];
  /** Free text the teacher typed for the topic, when it is not a catalog id. */
  topicText: string | null;
  itemTypes: Record<ItemType, number>;
  questionCount: number;
  distribution: "same" | "bank";
  bank?: { size: number; variants: number };
  columns: 1 | 2;
  maxPages: "auto" | number;
  durationMinutes: number;
  instrument: Instrument;
  calculator: boolean;
  introOverride: string | null;
  closing: { kind: ClosingKind; pinned: string | null };
  schoolYear: number;
  /** Proposed folder slug (without the `NN-` prefix). */
  slug: string;
  status: "draft";
  createdAt: string;
}

export interface ExamProgress {
  phase: string;
  revision: number;
  gates: Record<string, { decision: string; at: string }>;
}

export interface EvaluaState {
  schemaVersion: 1;
  /** Workspace-relative evalua root (default `evalua`). */
  root: string;
  activeExamId: string | null;
  /** Highest exam number ever allocated: numbers are never reused. */
  lastExamNumber: number;
  exams: Record<string, ExamProgress>;
  interview?: InterviewState;
  draft?: ExamDraft;
  createdAt: string;
  updatedAt: string;
}
