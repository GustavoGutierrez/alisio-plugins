import type { PluginAPI, Question } from "@alisio/sdk";
import {
  type LoadedProject,
  type LoadProjectOptions,
  loadProject,
  runChecks,
} from "./checks/index.js";
import type { Delegator } from "./delegate.js";
import type { BuildOutcome } from "./render/build.js";
import type { BuildScope } from "./render/model.js";
import type { ScholarClient } from "./research/client.js";
import { readState, writeState } from "./storage.js";
import type { Brief, Finding, Gate, ThesisState } from "./types.js";
import { thesisRootPath } from "./workspace.js";

/** Everything the phase workflows share. */
export interface WorkflowContext {
  api: PluginAPI;
  now: () => Date;
  projectOptions: LoadProjectOptions;
  scholar: ScholarClient;
  delegator: Delegator;
  env: NodeJS.ProcessEnv;
  cacheRoot: () => string;
  /** Builds the thesis through the coordinator (records the build in the state). */
  build?: (
    workspace: string,
    input: { scope: BuildScope; section?: string; pdfa?: boolean },
  ) => Promise<BuildOutcome>;
}

export interface Loaded {
  workspace: string;
  /** Session that issued the command; parent of every child session. */
  sessionId: string;
  state: ThesisState;
  /** Absolute thesis root. */
  base: string;
  project: LoadedProject;
  brief: Brief;
}

/** A command cannot run yet; the message is the reason, shown to the user as "Blocked: ...". */
export class Blocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Blocked";
  }
}

export async function loadAll(
  context: WorkflowContext,
  workspace: string,
  sessionId: string,
): Promise<Loaded> {
  const state = await readState(workspace);
  if (!state) throw new Error("No thesis workspace here. Run /thesis:init first.");
  if (state.phase === "intake" || state.pendingQuestions) {
    throw new Blocked("finish the intake interview first (/thesis:init, /thesis:answer).");
  }
  const base = await thesisRootPath(workspace, state.root);
  const project = await loadProject(base, { ...context.projectOptions, state });
  const brief = project.brief?.brief;
  if (!brief) throw new Error("thesis.yaml has errors. Run /thesis:check and fix them first.");
  return { workspace, sessionId, state, base, project, brief };
}

export const saveState = (loaded: Loaded): Promise<void> =>
  writeState(loaded.workspace, loaded.state);

/** Re-read the project after files changed, keeping the in-memory state. */
export async function reload(context: WorkflowContext, loaded: Loaded): Promise<void> {
  loaded.project = await loadProject(loaded.base, {
    ...context.projectOptions,
    state: loaded.state,
  });
}

export function gateFindings(loaded: Loaded, gate: Gate, now: () => Date): Finding[] {
  return runChecks(loaded.project, { gates: [gate], now }).findings;
}

export const errorsOf = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => finding.severity === "error");

export const describeFinding = (finding: Finding): string =>
  `${finding.code}${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}: ${finding.message}`;

/** Ask one interactive question; undefined when headless or when the user skipped it. */
export async function askOne(
  api: PluginAPI,
  label: string,
  question: Question,
): Promise<{ value: string; text?: string } | undefined> {
  if (!api.ui.interactive()) return undefined;
  const answers = await api.ui.askQuestions({ label, questions: [question] });
  const value = answers[question.id];
  if (typeof value !== "string") return undefined;
  const text = answers[`${question.id}:text`];
  return typeof text === "string" && text.trim() ? { value, text: text.trim() } : { value };
}

/**
 * Keep the phase in step with section approvals: all sections approved means review, anything less
 * means sections. Later phases (final, submitted) are never moved back from here.
 */
export function syncPhase(state: ThesisState): void {
  if (state.phase !== "sections" && state.phase !== "review") return;
  const sections = Object.values(state.sections);
  state.phase =
    sections.length > 0 && sections.every((section) => section.status === "approved")
      ? "review"
      : "sections";
}
