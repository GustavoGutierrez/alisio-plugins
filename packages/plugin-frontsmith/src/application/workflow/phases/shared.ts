import type { GateReport } from "../../../domain/gates/aggregate.js";
import type { FeatureState, GateId } from "../../../domain/state/feature-state.js";
import { nextPhase, type Phase } from "../../../domain/state/phases.js";
import type { PromptSection } from "../../agents/prompts.js";
import { type PhaseEnv, readJson, updateState } from "../env.js";

export const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`;

/** The failing findings of the last report of a gate, as a short list for a retry prompt. */
export async function failureSummary(
  env: PhaseEnv,
  state: FeatureState,
  gate: GateId,
): Promise<PromptSection | undefined> {
  const entry = state.gates[gate];
  if (!entry || entry.verdict === "PASS") return undefined;
  const report = await readJson<GateReport>(env, entry.reportPath);
  if (!report) return undefined;
  const lines = report.findings
    .filter((f) => f.status === "FAIL" || f.status === "BLOCKED")
    .slice(0, 30)
    .map(
      (f) =>
        `- ${f.id} ${f.ruleId}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.message}${f.fix ? ` (fix: ${f.fix})` : ""}`,
    );
  if (lines.length === 0) return undefined;
  return {
    title: `Problems found in the previous version (${gate} ${report.verdict})`,
    body: lines.join("\n"),
  };
}

/** Comments a person left when rejecting an approval of this phase's artifact (spec 7.4). */
export function feedbackSection(state: FeatureState, key: string): PromptSection | undefined {
  const comments = state.feedback?.[key];
  if (!comments || comments.length === 0) return undefined;
  return {
    title: "Comments from the person who rejected the previous version",
    body: comments.map((c) => `- ${c}`).join("\n"),
  };
}

export const compact = (value: unknown): string => JSON.stringify(value, null, 2);

export function sections(...items: Array<PromptSection | undefined>): PromptSection[] {
  return items.filter((item): item is PromptSection => item !== undefined);
}

/** Move the feature to the next phase of its level and clear a stale blocked marker. */
export async function advance(
  env: PhaseEnv,
  options: { tokensNeeded?: boolean } = {},
): Promise<Phase> {
  let target: Phase = "closed";
  await updateState(env, (draft) => {
    target =
      nextPhase(
        draft.level,
        draft.phase,
        draft.phase === "tokens" ? { tokensNeeded: true } : options,
      ) ?? "closed";
    draft.phase = target;
    delete draft.blocked;
  });
  return target;
}
