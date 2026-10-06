import type { PlanTask } from "../envelopes/plan.js";
import { isFeatureId, matchesId } from "../ids.js";
import type { Verdict } from "../verdict.js";
import { verdicts } from "../verdict.js";
import { isLevel, type Level } from "./levels.js";
import { isPhase, type Phase } from "./phases.js";

export const modes = ["build", "replicate", "refine", "redesign"] as const;
export type Mode = (typeof modes)[number];

export const gateIds = ["G0", "G1", "G2", "G2T", "G3", "G4", "G5", "G6", "G7", "G8", "G9"] as const;
export type GateId = (typeof gateIds)[number];

/** W-01: the artifact keys of `state.artifacts`, derived from the file list of spec 8.1. */
export const artifactKinds = [
  "context",
  "spec",
  "spec-json",
  "ui",
  "ui-contract",
  "tokens",
  "plan",
  "plan-json",
  "adr",
  "test-map",
  "tasks",
  "validation",
  "review",
  "retro",
  "source-spec",
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

/** W-02: the layer that produced a resolved model value. */
export const modelSources = ["runtime", "agents-md", "config", "host-options", "default"] as const;
export type ModelSource = (typeof modelSources)[number];

export interface Approval {
  at: string;
  by: "human";
  note?: string;
  hashes?: Record<string, string>;
}

export interface TaskState {
  id: string;
  layer: string;
  status: "pending" | "running" | "done" | "blocked";
  bounces: number;
  childSessionId?: string;
  changedPaths: string[];
  lastGate?: { verdict: Verdict; reportPath: string };
  origin: "plan" | "repair" | "remediation" | "l0";
}

/** Latest report of a gate, with the ids of its failing and blocked checks for status and next steps. */
export interface GateEntry {
  verdict: Verdict;
  reportPath: string;
  at: string;
  failedChecks?: string[];
  blockedChecks?: string[];
}

export interface QuestionState {
  id: string;
  question: string;
  blocking: boolean;
  answer?: string;
  answeredAt?: string;
  /** How the answer got in: the typed command, or a plugin dialog the person confirmed (provenance). */
  answeredVia?: "command" | "dialog";
}

/** `--from-spec`: where the specification came from and the immutable copy the run uses (AD-17). */
export interface SourceSpecRef {
  path: string;
  format: "markdown" | "spec-json";
  sha256: string;
  bytes: number;
  /** Workspace-relative path of the copy under the artifacts directory. */
  snapshot: string;
  importedAt: string;
}

export interface FeatureState {
  schemaVersion: 1;
  feature: string;
  intent: string;
  level: Level;
  mode: Mode;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  approvals: {
    spec?: Approval;
    uiContract?: Approval;
    plan?: Approval;
    acceptance?: Approval;
    reviewSignoff?: Approval;
    dependencies: Record<string, Approval>;
  };
  questions: QuestionState[];
  artifacts: Partial<Record<ArtifactKind, { path: string; sha256: string; writtenAt: string }>>;
  protected: Record<string, string>;
  tasks: TaskState[];
  counters: { repairRounds: number; remediations: number; envelopeRetries: number };
  gates: Partial<Record<GateId, GateEntry>>;
  lastModels: Record<string, { model: string; source: ModelSource }>;
  attemptSeq: number;
  job?: { id: string; unit: string; startedAt: string; ownerPid: number };
  /** `/frontsmith:verify-manual`: recorded manual evidence per acceptance criterion (W-25). */
  manualVerifications?: Record<string, { at: string; evidence: string }>;
  /** `/frontsmith:reject`: comments appended to the next prompt of the producing phase (W-26). */
  feedback?: Record<string, string[]>;
  /**
   * Contracts of tasks that are not in the plan: the L0 task and repair and remediation tasks (W-28).
   * `findings` lists the finding ids the task must fix.
   */
  taskContracts?: Record<string, PlanTask & { findings?: string[] }>;
  /** Present when the feature was created with `--from-spec`; absent otherwise (optional, schema stays 1). */
  source?: SourceSpecRef;
  /** Why the feature cannot move on without a person (W-27); cleared when the unit is re-run. */
  blocked?: { reason: string; at: string; gate?: GateId; task?: string };
}

export interface CreateFeatureInput {
  feature: string;
  intent: string;
  level: Level;
  mode: Mode;
  now: string;
}

export function createFeatureState(input: CreateFeatureInput): FeatureState {
  return {
    schemaVersion: 1,
    feature: input.feature,
    intent: input.intent,
    level: input.level,
    mode: input.mode,
    phase: "intake",
    createdAt: input.now,
    updatedAt: input.now,
    approvals: { dependencies: {} },
    questions: [],
    artifacts: {},
    protected: {},
    tasks: [],
    counters: { repairRounds: 0, remediations: 0, envelopeRetries: 0 },
    gates: {},
    lastModels: {},
    attemptSeq: 0,
    manualVerifications: {},
    feedback: {},
  };
}

export interface StateError {
  pointer: string;
  message: string;
}
export type StateValidation =
  | { ok: true; state: FeatureState }
  | { ok: false; errors: StateError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const taskStatuses = ["pending", "running", "done", "blocked"];
const taskOrigins = ["plan", "repair", "remediation", "l0"];

/** Structural validation of a version 1 state document. */
export function validateFeatureState(raw: unknown): StateValidation {
  const errors: StateError[] = [];
  const fail = (pointer: string, message: string): void => {
    errors.push({ pointer, message });
  };
  if (!isRecord(raw))
    return { ok: false, errors: [{ pointer: "", message: "state must be an object" }] };
  if (raw.schemaVersion !== 1) fail("/schemaVersion", "schemaVersion must be 1");
  if (!isFeatureId(raw.feature)) fail("/feature", "invalid feature id");
  if (typeof raw.intent !== "string" || raw.intent.length > 4000)
    fail("/intent", "intent must be a string of at most 4000 characters");
  if (!isLevel(raw.level)) fail("/level", "invalid level");
  if (!(modes as readonly string[]).includes(raw.mode as string)) fail("/mode", "invalid mode");
  if (!isPhase(raw.phase)) fail("/phase", "invalid phase");
  for (const key of ["createdAt", "updatedAt"] as const)
    if (typeof raw[key] !== "string") fail(`/${key}`, "must be an ISO-8601 string");
  if (!isRecord(raw.approvals) || !isRecord(raw.approvals.dependencies))
    fail("/approvals", "approvals.dependencies is required");
  if (!Array.isArray(raw.questions)) fail("/questions", "must be an array");
  else
    raw.questions.forEach((question, index) => {
      if (!isRecord(question) || !matchesId("question", question.id))
        fail(`/questions/${index}`, "invalid question");
    });
  if (raw.source !== undefined) {
    const source = raw.source;
    if (
      !isRecord(source) ||
      typeof source.path !== "string" ||
      typeof source.sha256 !== "string" ||
      typeof source.snapshot !== "string" ||
      (source.format !== "markdown" && source.format !== "spec-json")
    )
      fail("/source", "source must hold path, format, sha256 and snapshot");
  }
  if (!isRecord(raw.artifacts)) fail("/artifacts", "must be an object");
  if (!isRecord(raw.protected)) fail("/protected", "must be an object");
  if (!Array.isArray(raw.tasks)) fail("/tasks", "must be an array");
  else
    raw.tasks.forEach((task, index) => {
      if (!isRecord(task)) {
        fail(`/tasks/${index}`, "task must be an object");
        return;
      }
      if (!matchesId("task", task.id)) fail(`/tasks/${index}/id`, "invalid task id");
      if (!taskStatuses.includes(task.status as string))
        fail(`/tasks/${index}/status`, "invalid status");
      if (!taskOrigins.includes(task.origin as string))
        fail(`/tasks/${index}/origin`, "invalid origin");
      if (!Number.isInteger(task.bounces)) fail(`/tasks/${index}/bounces`, "must be an integer");
      if (!Array.isArray(task.changedPaths))
        fail(`/tasks/${index}/changedPaths`, "must be an array");
    });
  const counters = raw.counters;
  if (
    !isRecord(counters) ||
    !["repairRounds", "remediations", "envelopeRetries"].every((key) =>
      Number.isInteger(counters[key]),
    )
  )
    fail("/counters", "counters must hold three integers");
  if (!isRecord(raw.gates)) fail("/gates", "must be an object");
  else
    for (const [gate, entry] of Object.entries(raw.gates)) {
      if (!(gateIds as readonly string[]).includes(gate)) fail(`/gates/${gate}`, "unknown gate");
      else if (
        !isRecord(entry) ||
        !(verdicts as readonly string[]).includes(entry.verdict as string)
      )
        fail(`/gates/${gate}`, "invalid gate entry");
    }
  if (!isRecord(raw.lastModels)) fail("/lastModels", "must be an object");
  if (!Number.isInteger(raw.attemptSeq)) fail("/attemptSeq", "must be an integer");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, state: raw as unknown as FeatureState };
}
