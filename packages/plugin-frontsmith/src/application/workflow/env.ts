import type { PatternsCatalog } from "../../domain/architecture/patterns.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import type { EnvelopeKind } from "../../domain/envelopes/parse.js";
import {
  buildGateReport,
  type GateOutcome,
  type GateReport,
} from "../../domain/gates/aggregate.js";
import type { ArtifactKind, FeatureState, GateId } from "../../domain/state/feature-state.js";
import type { Verdict } from "../../domain/verdict.js";
import type { DelegateDeps } from "../agents/delegate.js";
import { type DelegateOutcome, type DelegateRequest, delegate } from "../agents/delegate.js";
import type { ArchitectureService } from "../architecture/service.js";
import type { AssetReader } from "../ports/asset-reader.js";
import type { Clock } from "../ports/clock.js";
import type { FeatureStore } from "../ports/feature-store.js";
import type { FileAnalyzer } from "../ports/file-analyzer.js";
import type { Git } from "../ports/git.js";
import type { IntegrityReader } from "../ports/integrity.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { ModuleResolver, WorkspaceFs } from "../ports/workspace-fs.js";
import type { WorkspaceWriter } from "../ports/workspace-writer.js";
import type { RulesService } from "../rules/rules-service.js";
import type { TokensService } from "../tokens/service.js";
import type { JobManager } from "./jobs.js";

/** Optional visual-fidelity capability (P9); absent means the pipeline cannot run (BLOCKED). */
export interface FidelityPort {
  /** Run the pipeline for the feature's cases; resolves to a gate-ready summary. */
  run(input: {
    root: string;
    feature: string;
    contractPath: string;
    cases?: readonly string[];
    runId: string;
    signal?: AbortSignal;
  }): Promise<import("../../domain/gates/aggregate.js").Prepared>;
  /** Runtime accessibility (axe, focus order, real pairs). */
  a11y(input: {
    root: string;
    feature: string;
    contractPath: string;
    cases?: readonly string[];
    runId: string;
    signal?: AbortSignal;
  }): Promise<import("../../domain/gates/aggregate.js").Prepared>;
}

/** Everything the workflow needs from the outside world; tests substitute fakes. */
export interface WorkflowDeps {
  store: FeatureStore;
  project: ProjectStore;
  fsFor(root: string): WorkspaceFs;
  writer: WorkspaceWriter;
  rules: RulesService;
  architecture: ArchitectureService;
  tokens: TokensService;
  agents: DelegateDeps;
  process: ProcessRunner;
  git: Git;
  integrity: IntegrityReader;
  assets: AssetReader;
  resolver: ModuleResolver;
  analyzer: FileAnalyzer;
  patterns(): Promise<PatternsCatalog>;
  /** Problems with the model configuration, selectors validated against the host when it can (FSM-*). */
  modelProblems(root: string): Promise<string[]>;
  jobs: JobManager;
  clock: Clock;
  sha256(text: string): string;
  version: string;
  newId(): string;
  /** Append lines to `.gitignore` when missing; true when the file changed. */
  ignore(root: string, entries: string[]): Promise<boolean>;
  fidelity?: FidelityPort;
}

/** What the person is told after a unit ran. */
export type UnitResult =
  | { kind: "advanced"; message: string }
  | {
      kind: "waiting";
      reason: "approval" | "question" | "decision";
      message: string;
      command: string;
    }
  | { kind: "blocked"; message: string; gate?: GateId; task?: string }
  | { kind: "closed"; message: string }
  | { kind: "cancelled"; message: string };

export interface PhaseEnv {
  deps: WorkflowDeps;
  root: string;
  feature: string;
  /** The session children hang from. */
  parentSession: string;
  signal: AbortSignal;
  progress(line: string): void;
  /** Evidence directory of this unit run, workspace-relative. */
  evidenceDir: string;
  config: FrontsmithConfig;
}

export const artifactDirOf = (config: FrontsmithConfig, feature: string): string =>
  `${config.paths.artifacts.replace(/\/$/, "")}/${feature}`;

export async function readState(env: PhaseEnv): Promise<FeatureState> {
  const opened = await env.deps.store.read(env.root, env.feature);
  if (!opened) throw new Error(`Unknown feature: ${env.feature}`);
  return opened.state;
}

export function updateState(
  env: PhaseEnv,
  mutate: (draft: FeatureState) => void,
): Promise<FeatureState> {
  return env.deps.store.update(env.root, env.feature, mutate, env.deps.clock.now().toISOString());
}

/** Write an artifact file under `docs/frontsmith/<feature>/` and register it with its hash. */
export async function writeArtifact(
  env: PhaseEnv,
  kind: ArtifactKind,
  name: string,
  content: string,
): Promise<string> {
  const path = `${artifactDirOf(env.config, env.feature)}/${name}`;
  await env.deps.writer.write(env.root, path, content);
  const sha256 = env.deps.sha256(content);
  const writtenAt = env.deps.clock.now().toISOString();
  await updateState(env, (draft) => {
    draft.artifacts[kind] = { path, sha256, writtenAt };
  });
  return path;
}

/** Write a file that is not registered as an artifact (adr files, reports). */
export async function writePlain(env: PhaseEnv, name: string, content: string): Promise<string> {
  const path = `${artifactDirOf(env.config, env.feature)}/${name}`;
  await env.deps.writer.write(env.root, path, content);
  return path;
}

export async function readText(env: PhaseEnv, path: string): Promise<string | undefined> {
  const read = await env.deps.fsFor(env.root).read(path);
  return read.kind === "text" ? read.text : undefined;
}

export async function readJson<T>(env: PhaseEnv, path: string | undefined): Promise<T | undefined> {
  if (!path) return undefined;
  const text = await readText(env, path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The stored envelope of an artifact kind, or `undefined` when none was written. */
export async function loadArtifact<T>(
  env: PhaseEnv,
  state: FeatureState,
  kind: ArtifactKind,
): Promise<T | undefined> {
  return readJson<T>(env, state.artifacts[kind]?.path);
}

export async function writeEnvelope(
  env: PhaseEnv,
  kind: ArtifactKind,
  name: string,
  value: unknown,
): Promise<string> {
  return writeArtifact(env, kind, name, canonicalJson(value));
}

/**
 * Finish a gate: build the report, persist it as `reports/<gate>[-<task>].json`, remember it in the
 * state and record the gate run as an attempt (spec 10.2).
 */
export async function finishGate(
  env: PhaseEnv,
  gate: GateId,
  outcome: GateOutcome,
  options: { taskId?: string } = {},
): Promise<GateReport> {
  const now = env.deps.clock.now().toISOString();
  const report = buildGateReport({
    gate,
    feature: env.feature,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    outcome,
    generatedAt: now,
    version: env.deps.version,
  });
  const name = options.taskId ? `${gate}-${options.taskId}` : gate;
  const reportPath = await writePlain(env, `reports/${name}.json`, canonicalJson(report));
  await updateState(env, (draft) => {
    draft.gates[gate] = {
      verdict: report.verdict,
      reportPath,
      at: now,
      failedChecks: report.checks.filter((c) => c.status === "FAIL").map((c) => c.id),
      blockedChecks: report.checks
        .filter((c) => c.status === "BLOCKED" && c.required)
        .map((c) => c.id),
    };
    const task = options.taskId ? draft.tasks.find((t) => t.id === options.taskId) : undefined;
    if (task) task.lastGate = { verdict: report.verdict, reportPath };
  });
  const attempts = env.deps.store.attempts(env.root, env.feature);
  const seq = await attempts.begin({ kind: "gate", status: "running", startedAt: now });
  await attempts.finish(seq, { status: "completed", endedAt: now, reportPath });
  env.progress(`${gate}${options.taskId ? ` ${options.taskId}` : ""}: ${report.verdict}`);
  return report;
}

/** A gate verdict that lets the feature move on: REVIEW items go to a person at acceptance. */
export const passes = (verdict: Verdict): boolean => verdict === "PASS" || verdict === "REVIEW";

/** Run one child through the delegate helper and keep the feature's attempts and models current. */
export async function delegateChild<K extends EnvelopeKind>(
  env: PhaseEnv,
  request: Omit<DelegateRequest<K>, "workspace" | "parentSession" | "signal">,
): Promise<DelegateOutcome<K>> {
  const outcome = await delegate(
    { ...env.deps.agents, attempts: env.deps.store.attempts(env.root, env.feature) },
    { ...request, workspace: env.root, parentSession: env.parentSession, signal: env.signal },
  );
  if (outcome.status === "ok")
    await updateState(env, (draft) => {
      draft.lastModels[`fs-${request.role}`] = {
        model: outcome.model ?? "inherit",
        source: outcome.source,
      };
      if (outcome.retried) draft.counters.envelopeRetries += 1;
    });
  else if (outcome.status === "invalid")
    await updateState(env, (draft) => {
      draft.counters.envelopeRetries += 1;
    });
  return outcome;
}

/** The text of a failed child outcome, as shown to a person. */
export function describeFailure(
  outcome: Exclude<DelegateOutcome<EnvelopeKind>, { status: "ok" }>,
): string {
  switch (outcome.status) {
    case "invalid":
      return `The agent did not return a valid envelope after one retry: ${outcome.errors
        .slice(0, 5)
        .map((e) => `${e.pointer || "(root)"}: ${e.message}`)
        .join("; ")}. Needs your decision: run the unit again, or stop.`;
    case "failed":
      return `The child session failed: ${outcome.error}`;
    case "model-error":
      return outcome.message;
    case "cancelled":
      return "The run was cancelled.";
  }
}
