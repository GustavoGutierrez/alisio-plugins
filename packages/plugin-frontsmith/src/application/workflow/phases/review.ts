import { canonicalJson } from "../../../domain/canonical-json.js";
import type { PlanEnvelope } from "../../../domain/envelopes/plan.js";
import type { ReviewEnvelope } from "../../../domain/envelopes/review.js";
import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import type { GateReport } from "../../../domain/gates/aggregate.js";
import { gateG8 } from "../../../domain/gates/g8.js";
import { requirementsForLevel } from "../../../domain/state/levels.js";
import { capDiff, type PromptSection } from "../../agents/prompts.js";
import { renderReviewMd } from "../../render/review-md.js";
import { approvalCommand, approvalToLeave } from "../approvals.js";
import {
  delegateChild,
  describeFailure,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readJson,
  readState,
  type UnitResult,
  updateState,
  writeArtifact,
  writePlain,
} from "../env.js";
import { remediationDecision } from "../loops.js";
import { runTask } from "../task-runner.js";
import { advance, clip, compact, sections } from "./shared.js";
import { createFixTasks, evaluateG7, featurePaths } from "./validate.js";

/** A readable diff of the feature for the reviewer: new files in full, others as git diffs. */
async function featureDiff(env: PhaseEnv, paths: readonly string[]): Promise<string> {
  const { git, fsFor } = env.deps;
  const fs = fsFor(env.root);
  if (!(await git.isRepo(env.root)))
    return "(the workspace is not a git repository: no diff available)";
  const parts: string[] = [];
  for (const path of paths) {
    const before = await git.show(env.root, "HEAD", path);
    const read = await fs.read(path);
    if (before === undefined && read.kind === "text") parts.push(`new file ${path}\n${read.text}`);
    else if (read.kind !== "text") parts.push(`deleted ${path}`);
    else parts.push(await git.diff(env.root, undefined, [path]));
  }
  return parts.join("\n");
}

async function gateSummaries(
  env: PhaseEnv,
  state: Awaited<ReturnType<typeof readState>>,
): Promise<string> {
  const lines: string[] = [];
  for (const [id, entry] of Object.entries(state.gates)) {
    const report = await readJson<GateReport>(env, entry.reportPath);
    lines.push(
      `- ${id}: ${entry.verdict}${
        report
          ? ` (${
              report.checks
                .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
                .map((c) => `${c.id}: ${c.summary}`)
                .join("; ") || "no failing check"
            })`
          : ""
      }`,
    );
  }
  return lines.join("\n") || "No gate has run.";
}

async function runReviews(env: PhaseEnv): Promise<{ reviews: ReviewEnvelope[] } | UnitResult> {
  const state = await readState(env);
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const diff = capDiff(await featureDiff(env, featurePaths(state)));
  const body: PromptSection[] = sections(
    spec
      ? { title: "Spec (spec.json)", body: clip(compact(spec), 12000) }
      : { title: "Instruction", body: state.intent },
    contract ? { title: "UI contract", body: clip(compact(contract), 12000) } : undefined,
    plan ? { title: "Plan", body: clip(compact(plan), 10000) } : undefined,
    { title: "Gate reports", body: await gateSummaries(env, state) },
    { title: `Diff of the feature${diff.truncated ? " (truncated)" : ""}`, body: diff.text },
  );
  const reviews: ReviewEnvelope[] = [];
  const runs = requirementsForLevel(state.level).reviewRuns;
  for (let run = 1; run <= runs; run += 1) {
    env.progress(`review: reviewer run ${run} of ${runs}`);
    const outcome = await delegateChild(env, {
      role: "reviewer",
      kind: "review",
      title: `${env.feature} review ${run}`,
      sections: body,
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "review was cancelled." };
    if (outcome.status !== "ok") return blockReview(env, describeFailure(outcome));
    reviews.push(outcome.value);
  }
  return { reviews };
}

async function blockReview(env: PhaseEnv, message: string): Promise<UnitResult> {
  await updateState(env, (draft) => {
    draft.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G8" };
  });
  return { kind: "blocked", gate: "G8", message };
}

/** Review phase (spec 7.2 G8, 7.3): independent review, then bounded remediation rounds. */
export async function runReview(env: PhaseEnv): Promise<UnitResult> {
  for (;;) {
    const result = await runReviews(env);
    if (!("reviews" in result)) return result;
    const { reviews } = result;
    await writePlain(env, "reviews.json", canonicalJson(reviews));
    await writeArtifact(env, "review", "review.md", renderReviewMd(reviews, env.feature));
    const state = await readState(env);
    const report = await finishGate(env, "G8", gateG8({ level: state.level, reviews }));
    if (passes(report.verdict)) {
      const owed = approvalToLeave(await readState(env), "review");
      if (owed)
        return {
          kind: "waiting",
          reason: "approval",
          message: `Review passed (G8 ${report.verdict}). Read review.md, then sign off.`,
          command: approvalCommand(env.feature, owed),
        };
      await advance(env);
      return { kind: "advanced", message: `Review passed (G8 ${report.verdict}).` };
    }
    const open = report.findings.filter((f) => f.status === "FAIL").length;
    const decision = remediationDecision({
      remediations: state.counters.remediations,
      max: env.config.limits.maxRemediations,
      open,
    });
    if (decision.action !== "remediate") {
      return blockReview(
        env,
        decision.action === "stop"
          ? `G8 changes requested: ${decision.message}.`
          : `G8 ${report.verdict}.`,
      );
    }
    env.progress(`review: remediation round ${decision.round}`);
    await updateState(env, (draft) => {
      draft.counters.remediations = decision.round;
    });
    const ids = await createFixTasks(env, report, "remediation");
    for (const id of ids) {
      const outcome = await runTask(env, id);
      if (outcome.status === "cancelled")
        return { kind: "cancelled", message: "review was cancelled." };
      if (outcome.status === "blocked") return blockReview(env, outcome.message);
    }
    const g7 = await evaluateG7(env);
    if (!passes(g7.verdict))
      return blockReview(env, `Validation failed after remediation (G7 ${g7.verdict}).`);
  }
}
