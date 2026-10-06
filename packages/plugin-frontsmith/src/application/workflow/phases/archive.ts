import { canonicalJson } from "../../../domain/canonical-json.js";
import type { GateReport } from "../../../domain/gates/aggregate.js";
import type { RuleDef } from "../../../domain/rules/model.js";
import { renderRetroMd } from "../../render/retro-md.js";
import {
  delegateChild,
  describeFailure,
  type PhaseEnv,
  readJson,
  readState,
  type UnitResult,
  updateState,
  writeArtifact,
} from "../env.js";
import { advance, compact, sections } from "./shared.js";

/** Archive phase (spec 7.1, 9.2): retrospective and rule candidates; promotion stays a human command. */
export async function runArchive(env: PhaseEnv): Promise<UnitResult> {
  const state = await readState(env);
  const gateLines: string[] = [];
  for (const [id, entry] of Object.entries(state.gates)) {
    const report = await readJson<GateReport>(env, entry.reportPath);
    gateLines.push(
      `- ${id}: ${entry.verdict}${report ? ` (${report.findings.length} findings)` : ""}`,
    );
  }
  const context = await env.deps.rules.loadContext(env.root, state.level);
  env.progress("archive: archivist running");
  const outcome = await delegateChild(env, {
    role: "archivist",
    kind: "archive",
    title: `${env.feature} archivist`,
    sections: sections(
      {
        title: "State summary",
        body: compact({
          level: state.level,
          mode: state.mode,
          counters: state.counters,
          tasks: state.tasks.map((t) => ({
            id: t.id,
            origin: t.origin,
            bounces: t.bounces,
            status: t.status,
          })),
        }),
      },
      { title: "Gate reports", body: gateLines.join("\n") || "none" },
      {
        title: "Waivers used",
        body: context.waivers.map((w) => `- ${w.id} ${w.ruleId}: ${w.reason}`).join("\n") || "none",
      },
      {
        title: "Candidate format",
        body: "Each rule candidate carries a full workspace rule object: id (not starting with FS-), title, severity, kind, category, engine, params, files, appliesWhen, message, fix, rationale, source, suppressible, tags.",
      },
    ),
  });
  if (outcome.status === "cancelled")
    return { kind: "cancelled", message: "archive was cancelled." };
  if (outcome.status !== "ok") {
    const message = describeFailure(outcome);
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
    });
    return { kind: "blocked", message };
  }
  const kept: Array<{ id: string; rule: RuleDef }> = [];
  const dropped: string[] = [];
  for (const candidate of outcome.value.ruleCandidates) {
    const problems = env.deps.rules.validateCandidate(candidate.rule as unknown as RuleDef);
    if (problems.length > 0) dropped.push(`${candidate.id}: ${problems.slice(0, 2).join("; ")}`);
    else kept.push({ id: candidate.id, rule: candidate.rule as unknown as RuleDef });
  }
  if (kept.length > 0)
    await env.deps.writer.write(
      env.root,
      `.frontsmith/candidates/${env.feature}.json`,
      canonicalJson({ schemaVersion: 1, feature: env.feature, candidates: kept }),
    );
  await writeArtifact(env, "retro", "retro.md", renderRetroMd(outcome.value, env.feature, dropped));
  await advance(env);
  return {
    kind: "closed",
    message: `Archived: retro.md written, ${kept.length} rule candidate(s) stored${dropped.length > 0 ? `, ${dropped.length} dropped` : ""}.`,
  };
}
