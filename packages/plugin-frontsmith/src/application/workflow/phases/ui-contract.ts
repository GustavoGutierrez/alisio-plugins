import { canonicalJson } from "../../../domain/canonical-json.js";
import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import { gateG2, type ReferenceStatus } from "../../../domain/gates/g2.js";
import { renderUiMd } from "../../render/ui-md.js";
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
} from "../env.js";
import { inventoryRows, tokensPhaseNeeded } from "../project.js";
import {
  advance,
  blockOnSource,
  checkSourceSnapshot,
  clip,
  compact,
  failureSummary,
  feedbackSection,
  referenceSourceSection,
  sections,
} from "./shared.js";

export const referencesDir = (feature: string): string => `.frontsmith/references/${feature}`;

/**
 * Code-owned contract keys (B-15): the render defaults and the policies the envelope validator
 * rejects when an agent emits them. They are written after validation and protected on approval.
 */
export function withCodeOwnedKeys(
  contract: UiContractEnvelope,
  browser: string,
): UiContractEnvelope & Record<string, unknown> {
  return {
    ...contract,
    render: {
      browser,
      dpr: 1,
      locale: "en-US",
      timezone: "UTC",
      colorScheme: [...new Set(contract.cases.map((c) => c.theme))],
      reducedMotion: "reduce",
    },
    unknownBackground: "BLOCKED",
    allowedOrigins: [],
    calibration: { acceptableMutations: [] },
  };
}

export async function referenceStatuses(
  env: PhaseEnv,
  contract: UiContractEnvelope,
): Promise<ReferenceStatus[]> {
  const statuses: ReferenceStatus[] = [];
  for (const reference of contract.references) {
    const digest = await env.deps.integrity.digestFile(
      env.root,
      `${referencesDir(env.feature)}/${reference.file}`,
    );
    const sha = digest?.startsWith("file:") ? digest.split(":")[2] : undefined;
    statuses.push({
      file: reference.file,
      exists: digest !== undefined,
      ...(sha ? { sha256: sha } : {}),
    });
  }
  return statuses;
}

/** UI contract phase (spec 7.1, 9.2): the contractor writes it, code completes it and checks it (G2). */
export async function runUiContract(env: PhaseEnv): Promise<UnitResult> {
  const state = await readState(env);
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  if (!spec) {
    const message =
      "ui-contract needs the approved spec; run /frontsmith:next from the specify phase.";
    return { kind: "blocked", message };
  }
  let contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  const stale = state.gates.G2?.verdict === "FAIL";
  if (!contract || stale) {
    const source = await checkSourceSnapshot(env, state);
    if (!source.ok) return blockOnSource(env, source.message);
    const { deps } = env;
    const fs = deps.fsFor(env.root);
    const listing = await fs.listFiles();
    const refs = listing.files.filter((p) => p.startsWith(`${referencesDir(env.feature)}/`));
    const meta = await readText(env, `${referencesDir(env.feature)}/meta.json`);
    const rows = await inventoryRows(env);
    env.progress("ui-contract: contractor running");
    const outcome = await delegateChild(env, {
      role: "ui-contractor",
      kind: "ui-contract",
      title: `${env.feature} ui-contractor`,
      sections: sections(
        { title: "Approved spec (spec.json)", body: clip(compact(spec), 14000) },
        { title: "Mode", body: state.mode },
        {
          title: "Reference files",
          body:
            refs.length === 0
              ? "No reference files."
              : `${refs.map((r) => `- ${r}`).join("\n")}\n\nmeta.json:\n${meta ?? "(none)"}`,
        },
        {
          title: "Existing design tokens",
          body:
            rows
              .filter((r) => r.kind === "token")
              .slice(0, 150)
              .map((r) => `- ${r.name} (${r.path})`)
              .join("\n") || "None found.",
        },
        {
          title: "Existing components",
          body:
            rows
              .filter((r) => r.kind === "component")
              .slice(0, 100)
              .map((r) => `- ${r.name} (${r.path})`)
              .join("\n") || "None found.",
        },
        source.text !== undefined ? referenceSourceSection(source.text) : undefined,
        feedbackSection(state, "ui-contract"),
        stale ? await failureSummary(env, state, "G2") : undefined,
      ),
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "ui-contract was cancelled." };
    if (outcome.status !== "ok") {
      const message = describeFailure(outcome);
      await updateState(env, (d) => {
        d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
      });
      return { kind: "blocked", message };
    }
    contract = outcome.value;
    await writeArtifact(
      env,
      "ui-contract",
      "ui-contract.json",
      canonicalJson(withCodeOwnedKeys(contract, env.config.fidelity.browser)),
    );
    await writeArtifact(env, "ui", "ui.md", renderUiMd(contract, env.feature));
    await updateState(env, (d) => {
      delete d.feedback?.["ui-contract"];
      delete d.blocked;
    });
  }
  const report = await finishGate(
    env,
    "G2",
    gateG2({
      contract,
      spec,
      mode: state.mode,
      references: await referenceStatuses(env, contract),
    }),
  );
  if (!passes(report.verdict)) {
    const message = `G2 ${report.verdict}: ${report.checks
      .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
      .map((c) => `${c.id}: ${c.summary}`)
      .join("; ")}.`;
    const fixable = report.verdict === "FAIL";
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G2" };
    });
    return {
      kind: "blocked",
      gate: "G2",
      message: fixable
        ? `${message} Run /frontsmith:next ${env.feature} to have the contractor fix it.`
        : message,
    };
  }
  const owed = approvalToLeave(await readState(env), "ui-contract");
  if (owed)
    return {
      kind: "waiting",
      reason: "approval",
      message: `UI contract ready (G2 ${report.verdict}). Review ui.md, then approve it.`,
      command: approvalCommand(env.feature, owed),
    };
  await advance(env, { tokensNeeded: await tokensPhaseNeeded(env, contract) });
  return { kind: "advanced", message: `UI contract ready (G2 ${report.verdict}).` };
}
