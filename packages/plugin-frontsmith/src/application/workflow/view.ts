import type { PlanEnvelope } from "../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import type { FeatureState } from "../../domain/state/feature-state.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";
import { approvalToLeave, gateOfPhase } from "./approvals.js";
import { gateHolds, type NextAction, nextAction, openBlockingQuestions } from "./status.js";

const QUESTION_CLIP = 500;

/** What the conversational coordinator reads with `fs_status` (spec 18.3): state, never prose. */
export interface CoordinatorView {
  feature: string;
  level: string;
  mode: string;
  phase: string;
  blocked: string | null;
  running: boolean;
  job: { id: string; unit: string } | null;
  next: NextAction;
  gate: { id: string; verdict: string; failing: string[]; blocking: string[] } | null;
  openQuestions: Array<{
    id: string;
    question: string;
    blocking: boolean;
    options: string[];
    recommendation: string | null;
  }>;
  owedApproval: string | null;
  pendingDependencies: string[];
  artifacts: string[];
  source: { path: string; format: string; sha256: string } | null;
  /** The fixed last line of every coordinator reply. */
  footer: string;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

async function readJson<T>(fs: WorkspaceFs, path: string | undefined): Promise<T | undefined> {
  if (!path) return undefined;
  try {
    const read = await fs.read(path);
    return read.kind === "text" ? (JSON.parse(read.text) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function footerLine(
  view: Pick<
    CoordinatorView,
    "feature" | "level" | "mode" | "phase" | "gate" | "next" | "job" | "running"
  >,
): string {
  const gate = view.gate ? `${view.gate.id} ${view.gate.verdict}` : "none";
  const next = view.running && view.job ? `waiting for job ${view.job.id}` : view.next.command;
  return `Feature: ${view.feature} (${view.level}, ${view.mode}) · Phase: ${view.phase} · Gate: ${gate} · Next: ${next}`;
}

export async function buildCoordinatorView(
  fs: WorkspaceFs,
  state: FeatureState,
  running: boolean,
): Promise<CoordinatorView> {
  const spec = await readJson<SpecEnvelope>(fs, state.artifacts["spec-json"]?.path);
  const plan = await readJson<PlanEnvelope>(fs, state.artifacts["plan-json"]?.path);
  const gateId = gateOfPhase(state.phase);
  const entry = gateId ? state.gates[gateId] : undefined;
  const owed = approvalToLeave(state, state.phase);
  const blocking = new Set(openBlockingQuestions(state).map((q) => q.id));
  const view = {
    feature: state.feature,
    level: state.level,
    mode: state.mode,
    phase: state.phase,
    blocked: state.blocked ? clip(state.blocked.reason, 500) : null,
    running,
    job: state.job && running ? { id: state.job.id, unit: state.job.unit } : null,
    next: nextAction(state, running),
    gate:
      gateId && entry
        ? {
            id: gateId,
            verdict: entry.verdict,
            failing: entry.failedChecks ?? [],
            blocking: entry.blockedChecks ?? [],
          }
        : null,
    openQuestions: state.questions
      .filter((q) => q.answer === undefined || q.answer === "")
      .map((q) => {
        const origin = spec?.openQuestions.find((o) => o.id === q.id);
        return {
          id: q.id,
          question: clip(q.question, QUESTION_CLIP),
          blocking: q.blocking && blocking.has(q.id),
          options: (origin?.options ?? []).map((o) => clip(o, QUESTION_CLIP)),
          recommendation: origin?.recommendation
            ? clip(origin.recommendation, QUESTION_CLIP)
            : null,
        };
      }),
    owedApproval: owed && gateHolds(state, state.phase) ? owed : null,
    pendingDependencies: (plan?.dependencies ?? [])
      .map((d) => d.name)
      .filter((name) => !state.approvals.dependencies[name]),
    artifacts: Object.values(state.artifacts)
      .map((a) => a.path)
      .filter((p) => /\.md$/.test(p)),
    source: state.source
      ? { path: state.source.path, format: state.source.format, sha256: state.source.sha256 }
      : null,
  };
  return { ...view, footer: footerLine(view) };
}
