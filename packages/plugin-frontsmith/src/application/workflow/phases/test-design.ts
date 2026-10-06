import type { PlanEnvelope } from "../../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import type { TestMapEnvelope } from "../../../domain/envelopes/test-map.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import { gateG4 } from "../../../domain/gates/g4.js";
import { detectStack } from "../../detect/stack.js";
import {
  delegateChild,
  describeFailure,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readState,
  type UnitResult,
  updateState,
  writeEnvelope,
} from "../env.js";
import { advance, clip, compact, failureSummary, feedbackSection, sections } from "./shared.js";

/** Test-design phase (spec 7.1, 9.2): the test engineer maps criteria to tests in design mode; code checks it (G4). */
export async function runTestDesign(env: PhaseEnv): Promise<UnitResult> {
  const state = await readState(env);
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  if (!spec || !plan)
    return { kind: "blocked", message: "test-design needs the approved spec and plan." };
  const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  let map = await loadArtifact<TestMapEnvelope>(env, state, "test-map");
  const stale = state.gates.G4?.verdict === "FAIL";
  if (!map || stale) {
    const stack = await detectStack(env.deps.fsFor(env.root), env.deps.resolver);
    env.progress("test-design: test engineer running (design mode)");
    const outcome = await delegateChild(env, {
      role: "test-engineer",
      kind: "test-map",
      mode: "design",
      title: `${env.feature} test-design`,
      sections: sections(
        { title: "Acceptance criteria", body: compact(spec.acceptanceCriteria) },
        contract
          ? { title: "State matrix", body: clip(compact(contract.stateMatrix), 6000) }
          : undefined,
        contract ? { title: "Cases", body: clip(compact(contract.cases), 3000) } : undefined,
        {
          title: "Planned tasks",
          body: clip(
            compact(
              plan.tasks.map((t) => ({
                id: t.id,
                layer: t.layer,
                files: t.files,
                acceptanceCriteria: t.acceptanceCriteria,
                tests: t.tests,
              })),
            ),
            8000,
          ),
        },
        { title: "Detected test stack", body: stack.tests.join(", ") || "none detected" },
        feedbackSection(state, "test-design"),
        stale ? await failureSummary(env, state, "G4") : undefined,
      ),
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "test-design was cancelled." };
    if (outcome.status !== "ok") {
      const message = describeFailure(outcome);
      await updateState(env, (d) => {
        d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
      });
      return { kind: "blocked", message };
    }
    map = outcome.value;
    await writeEnvelope(env, "test-map", "test-map.json", map);
    await updateState(env, (d) => void delete d.blocked);
  }
  const report = await finishGate(
    env,
    "G4",
    gateG4({ spec, plan, testMap: map, ...(contract ? { contract } : {}) }),
  );
  if (!passes(report.verdict)) {
    const message = `G4 ${report.verdict}: ${report.checks
      .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
      .map((c) => `${c.id}: ${c.summary}`)
      .join("; ")}. Run /frontsmith:next ${env.feature} to have the test engineer fix it.`;
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G4" };
    });
    return { kind: "blocked", gate: "G4", message };
  }
  await advance(env);
  return { kind: "advanced", message: `Test map ready (G4 ${report.verdict}).` };
}
