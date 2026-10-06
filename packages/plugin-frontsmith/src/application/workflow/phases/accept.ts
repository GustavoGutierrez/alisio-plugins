import type { PlanEnvelope } from "../../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import type { TestMapEnvelope } from "../../../domain/envelopes/test-map.js";
import type { GateReport } from "../../../domain/gates/aggregate.js";
import { gateG9 } from "../../../domain/gates/g9.js";
import { activeWaivers } from "../../../domain/rules/waivers.js";
import type { FeatureState } from "../../../domain/state/feature-state.js";
import { buildTrace } from "../../../domain/traceability.js";
import { renderValidationMd } from "../../render/validation-md.js";
import { approvalCommand, approvalToLeave } from "../approvals.js";
import {
  artifactDirOf,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readJson,
  readState,
  type UnitResult,
  updateState,
  writeArtifact,
} from "../env.js";
import { advance } from "./shared.js";

async function reports(
  env: PhaseEnv,
  state: FeatureState,
): Promise<Partial<Record<string, GateReport>>> {
  const out: Partial<Record<string, GateReport>> = {};
  for (const [id, entry] of Object.entries(state.gates)) {
    const report = await readJson<GateReport>(env, entry.reportPath);
    if (report) out[id] = report;
  }
  return out;
}

/** Evaluate G9 and render `validation.md`: traceability, waivers and what was not verified. */
export async function evaluateAcceptance(env: PhaseEnv): Promise<GateReport> {
  const state = await readState(env);
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const testMap = await loadArtifact<TestMapEnvelope>(env, state, "test-map");
  const gates = await reports(env, state);
  const trace = spec
    ? buildTrace({
        spec,
        plan,
        testMap,
        manual: state.manualVerifications ?? {},
        passedTasks: new Set(
          state.tasks
            .filter(
              (t) =>
                t.status === "done" &&
                t.lastGate &&
                (t.lastGate.verdict === "PASS" || t.lastGate.verdict === "REVIEW"),
            )
            .map((t) => t.id),
        ),
        validation: state.gates.G7?.verdict,
      })
    : [];
  const blockedChecks = Object.entries(state.gates).flatMap(([id, entry]) =>
    entry.verdict === "BLOCKED" ? (entry.blockedChecks ?? []).map((c) => `${id} ${c}`) : [],
  );
  const context = await env.deps.rules.loadContext(env.root, state.level);
  const today = env.deps.clock.now().toISOString().slice(0, 10);
  const expired = activeWaivers(context.waivers, today).expired.map((w) => w.id);
  const deviations: string[] = [];
  for (const task of state.tasks) {
    const result = await readJson<{ deviations?: string[] }>(
      env,
      `${artifactDirOf(env.config, env.feature)}/results/${task.id}.json`,
    );
    for (const deviation of result?.deviations ?? []) deviations.push(`${task.id}: ${deviation}`);
  }
  const commands = Object.values(gates).flatMap((report) =>
    (report?.checks ?? [])
      .filter((c) => c.id.startsWith("command:"))
      .map((c) => ({
        name: c.id.slice(8),
        argv: report?.gate ?? "",
        status: c.status,
        summary: c.summary,
      })),
  );
  const text = renderValidationMd({
    feature: env.feature,
    specSha256: state.artifacts["spec-json"]?.sha256,
    trace,
    commands,
    gates,
    uiEvidence:
      gates.G7?.checks
        .filter((c) => c.id === "fidelity")
        .map((c) => `fidelity: ${c.status} (${c.summary})`) ?? [],
    accessibility: [
      ...(gates.G7?.checks
        .filter((c) => c.id.startsWith("a11y"))
        .map((c) => `${c.id}: ${c.status} (${c.summary})`) ?? []),
      "Automated checks do not establish WCAG conformance.",
    ],
    performance:
      gates.G7?.checks
        .filter((c) => c.id === "budgets")
        .map((c) => `budgets: ${c.status} (${c.summary})`) ?? [],
    limitations: Object.entries(gates)
      .filter(([, r]) => r?.verdict === "REVIEW")
      .map(([id]) => `${id} has review items a person must read.`),
    deviations,
  });
  await writeArtifact(env, "validation", "validation.md", text);
  return finishGate(
    env,
    "G9",
    gateG9({ trace, blockedChecks, expiredWaivers: expired, deviations }),
  );
}

/** Accept phase (spec 7.2 G9): the evidence package, then the human acceptance. */
export async function runAccept(env: PhaseEnv): Promise<UnitResult> {
  const report = await evaluateAcceptance(env);
  if (!passes(report.verdict)) {
    const message = `G9 ${report.verdict}: ${report.checks
      .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
      .map((c) => `${c.id}: ${c.summary}`)
      .join("; ")}.`;
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G9" };
    });
    return { kind: "blocked", gate: "G9", message };
  }
  await updateState(env, (d) => void delete d.blocked);
  const owed = approvalToLeave(await readState(env), "accept");
  if (owed)
    return {
      kind: "waiting",
      reason: "approval",
      message: `Acceptance evidence ready (G9 ${report.verdict}). Read validation.md, then accept.`,
      command: approvalCommand(env.feature, owed),
    };
  await advance(env);
  return { kind: "advanced", message: `Accepted (G9 ${report.verdict}).` };
}
