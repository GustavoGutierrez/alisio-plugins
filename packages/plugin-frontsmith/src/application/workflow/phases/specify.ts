import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import { gateG1 } from "../../../domain/gates/g1.js";
import { renderSpecMd } from "../../render/spec-md.js";
import { approvalCommand, approvalToLeave } from "../approvals.js";
import {
  delegateChild,
  describeFailure,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readState,
  readText,
  type UnitResult,
  updateState,
  writeArtifact,
  writeEnvelope,
} from "../env.js";
import { openBlockingQuestions } from "../status.js";
import { advance, clip, failureSummary, feedbackSection, sections } from "./shared.js";

/** Specify phase (spec 7.1, 9.2): the specifier writes the spec, code renders and checks it (G1). */
export async function runSpecify(env: PhaseEnv): Promise<UnitResult> {
  let state = await readState(env);
  let spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  const stale = state.gates.G1?.verdict === "FAIL";
  if (!spec || stale) {
    const context = state.artifacts.context
      ? await readText(env, state.artifacts.context.path)
      : undefined;
    const answered = state.questions.filter((q) => q.answer !== undefined && q.answer !== "");
    env.progress("specify: specifier running");
    const outcome = await delegateChild(env, {
      role: "specifier",
      kind: "spec",
      title: `${env.feature} specifier`,
      sections: sections(
        { title: "Intent", body: state.intent },
        { title: "Level and mode", body: `Level ${state.level}, mode ${state.mode}.` },
        context ? { title: "Repository context", body: clip(context, 8000) } : undefined,
        answered.length > 0
          ? {
              title: "Answers to earlier questions",
              body: answered
                .map((q) => `- ${q.id} ${q.question}\n  Answer: ${q.answer}`)
                .join("\n"),
            }
          : undefined,
        feedbackSection(state, "spec"),
        stale ? await failureSummary(env, state, "G1") : undefined,
      ),
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "specify was cancelled." };
    if (outcome.status !== "ok") {
      const message = describeFailure(outcome);
      await updateState(env, (d) => {
        d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
      });
      return { kind: "blocked", message };
    }
    spec = outcome.value;
    await writeEnvelope(env, "spec-json", "spec.json", spec);
    await writeArtifact(env, "spec", "spec.md", renderSpecMd(spec, env.feature));
    await updateState(env, (draft) => {
      for (const q of spec?.openQuestions ?? [])
        if (!draft.questions.some((existing) => existing.id === q.id))
          draft.questions.push({ id: q.id, question: q.question, blocking: q.blocking });
      delete draft.feedback?.spec;
      delete draft.blocked;
    });
    state = await readState(env);
  }
  const report = await finishGate(env, "G1", gateG1({ spec, questions: state.questions }));
  const open = openBlockingQuestions(state)[0];
  if (report.verdict === "BLOCKED" && open) {
    return {
      kind: "waiting",
      reason: "question",
      message: `${open.id} blocks the spec: ${open.question}`,
      command: `/frontsmith:answer ${env.feature} ${open.id} -- <answer>`,
    };
  }
  if (!passes(report.verdict)) {
    const message = `G1 ${report.verdict}: ${report.checks
      .filter((c) => c.status !== "PASS" && c.status !== "SKIPPED")
      .map((c) => `${c.id}: ${c.summary}`)
      .join("; ")}. Run /frontsmith:next ${env.feature} to have the specifier fix it.`;
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G1" };
    });
    return { kind: "blocked", gate: "G1", message };
  }
  const owed = approvalToLeave(await readState(env), "specify");
  if (owed)
    return {
      kind: "waiting",
      reason: "approval",
      message: `Spec ready (G1 ${report.verdict}). Review docs spec.md, then approve it.`,
      command: approvalCommand(env.feature, owed),
    };
  await advance(env);
  return { kind: "advanced", message: `Spec ready (G1 ${report.verdict}).` };
}
