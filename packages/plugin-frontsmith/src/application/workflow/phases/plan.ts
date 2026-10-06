import {
  type ArchitectureConfig,
  parseArchitectureConfig,
} from "../../../domain/architecture/config.js";
import { checkPlannedGraph } from "../../../domain/architecture/planned.js";
import type { PlanEnvelope } from "../../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../../domain/envelopes/spec.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import { type G3Input, gateG3 } from "../../../domain/gates/g3.js";
import { renderAdrMd } from "../../render/adr-md.js";
import { renderPlanMd } from "../../render/plan-md.js";
import { renderTasksMd } from "../../render/tasks-md.js";
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
  writePlain,
} from "../env.js";
import { advance, clip, compact, failureSummary, feedbackSection, sections } from "./shared.js";

const CONTRACT_FILE =
  /(?:^|\/)(?:openapi|swagger|asyncapi|schema)[^/]*\.(?:json|ya?ml|graphql)$|\.graphql$/i;

/** OpenAPI operation ids of a JSON document; `undefined` when the file is not parseable JSON. */
export function openApiOperations(text: string): string[] | undefined {
  try {
    const doc = JSON.parse(text) as {
      paths?: Record<string, Record<string, { operationId?: unknown }>>;
    };
    if (!doc || typeof doc !== "object" || typeof doc.paths !== "object") return undefined;
    return Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item ?? {}).flatMap((op) =>
        typeof op?.operationId === "string" ? [op.operationId] : [],
      ),
    );
  } catch {
    return undefined;
  }
}

/** The architecture a plan is judged against: the project's file, or the plan's valid proposal. */
export async function planArchitecture(
  env: PhaseEnv,
  plan: PlanEnvelope,
): Promise<{ config: ArchitectureConfig | undefined; present: boolean; problems: string[] }> {
  const existing = await env.deps.project.readArchitecture(env.root);
  if (existing.config) return { config: existing.config, present: true, problems: [] };
  if (plan.architectureConfig) {
    const parsed = parseArchitectureConfig(plan.architectureConfig);
    if (parsed.ok) return { config: parsed.config, present: false, problems: [] };
    return {
      config: undefined,
      present: false,
      problems: parsed.errors.map((e) => `architectureConfig ${e.pointer || "/"}: ${e.message}`),
    };
  }
  return {
    config: undefined,
    present: false,
    problems: existing.errors.map((e) => `architecture.json: ${e.message}`),
  };
}

async function g3Input(env: PhaseEnv, plan: PlanEnvelope, spec: SpecEnvelope): Promise<G3Input> {
  const state = await readState(env);
  const architecture = await planArchitecture(env, plan);
  const violations = [...architecture.problems];
  if (architecture.config) {
    const files = [
      ...new Set([...plan.components.map((c) => c.path), ...plan.tasks.flatMap((t) => t.files)]),
    ];
    violations.push(
      ...checkPlannedGraph(architecture.config, {
        files,
        imports: plan.components.flatMap((c) => c.imports.map((to) => ({ from: c.path, to }))),
      }).map((v) => `${v.file}: ${v.detail}`),
    );
  }
  const contractFiles: Record<string, { exists: boolean; operations?: readonly string[] }> = {};
  for (const contract of plan.contracts) {
    const text = await readText(env, contract.file);
    const operations =
      text !== undefined && contract.file.endsWith(".json") ? openApiOperations(text) : undefined;
    contractFiles[contract.file] = {
      exists: text !== undefined,
      ...(operations ? { operations } : {}),
    };
  }
  const catalog = await env.deps.patterns();
  return {
    plan,
    spec,
    level: state.level,
    limits: {
      maxTaskFiles: env.config.limits.maxTaskFiles,
      maxTaskCriteria: env.config.limits.maxTaskCriteria,
    },
    patternIds: new Set(catalog.patterns.map((p) => p.id)),
    contractFiles,
    plannedGraph: { architecturePresent: architecture.config !== undefined, violations },
    approvedDependencies: new Set(Object.keys(state.approvals.dependencies)),
  };
}

/** Evaluate G3 for a stored plan (used by the phase, by `approve plan` and by `/frontsmith:check`). */
export async function evaluatePlanGate(env: PhaseEnv, plan: PlanEnvelope, spec: SpecEnvelope) {
  return gateG3(await g3Input(env, plan, spec));
}

/** TODO(owner): B-13 L1 uses the same envelope with empty lists; gate G3 keeps the task checks. */
const levelNote = (level: string): { note?: string } =>
  level === "L1"
    ? {
        note: "Level L1: a lite plan is enough. Empty components, state, contracts, errors, decisions, risks and dependencies are fine; the tasks and their acceptance criteria are what matters.",
      }
    : level === "L3"
      ? {
          note: "Level L3: include at least one decision record and at least one risk of category security or privacy.",
        }
      : {};

/** Plan phase (spec 7.1, 9.2): the architect writes the plan and its task contracts; code checks it (G3). */
export async function runPlan(env: PhaseEnv): Promise<UnitResult> {
  const state = await readState(env);
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  if (!spec) return { kind: "blocked", message: "plan needs the approved spec." };
  let plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const stale = state.gates.G3?.verdict === "FAIL";
  if (!plan || stale) {
    const { deps } = env;
    const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
    const context = state.artifacts.context
      ? await readText(env, state.artifacts.context.path)
      : undefined;
    const architecture = await deps.project.readArchitecture(env.root);
    const catalog = await deps.patterns();
    const files = (await deps.fsFor(env.root).listFiles()).files
      .filter((p) => CONTRACT_FILE.test(p))
      .slice(0, 50);
    const tokens = state.artifacts.tokens
      ? await readText(env, state.artifacts.tokens.path)
      : undefined;
    env.progress("plan: architect running");
    const outcome = await delegateChild(env, {
      role: "architect",
      kind: "plan",
      title: `${env.feature} architect`,
      ...levelNote(state.level),
      sections: sections(
        { title: "Approved spec (spec.json)", body: clip(compact(spec), 12000) },
        contract
          ? { title: "UI contract (ui-contract.json)", body: clip(compact(contract), 14000) }
          : undefined,
        tokens ? { title: "Token result", body: clip(tokens, 4000) } : undefined,
        context ? { title: "Repository context", body: clip(context, 6000) } : undefined,
        {
          title: "Architecture configuration",
          body: architecture.config
            ? compact(architecture.config)
            : "none (propose one in architectureConfig at L2 and above)",
        },
        {
          title: "Pattern catalog",
          body: catalog.patterns.map((p) => `- ${p.id}: ${p.intent}`).join("\n"),
        },
        {
          title: "Contract files found",
          body: files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "none",
        },
        { title: "Build layers available", body: "ui, data, test" },
        feedbackSection(state, "plan"),
        stale ? await failureSummary(env, state, "G3") : undefined,
      ),
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "plan was cancelled." };
    if (outcome.status !== "ok") {
      const message = describeFailure(outcome);
      await updateState(env, (d) => {
        d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
      });
      return { kind: "blocked", message };
    }
    plan = outcome.value;
    await writeEnvelope(env, "plan-json", "plan.json", plan);
    await writeArtifact(env, "plan", "plan.md", renderPlanMd(plan, env.feature));
    await writeArtifact(env, "tasks", "tasks.md", renderTasksMd(plan.tasks, env.feature));
    for (const [index, adr] of plan.adrs.entries()) {
      const name = `adr/${adr.id}.md`;
      if (index === 0) await writeArtifact(env, "adr", name, renderAdrMd(adr));
      else await writePlain(env, name, renderAdrMd(adr));
    }
    await updateState(env, (d) => {
      delete d.feedback?.plan;
      delete d.blocked;
    });
  }
  const report = await finishGate(env, "G3", await evaluatePlanGate(env, plan, spec));
  const onlyDependencies =
    report.verdict === "BLOCKED" &&
    report.checks.every(
      (c) => c.status !== "FAIL" && (c.status !== "BLOCKED" || c.id === "new-dependencies"),
    );
  if (!passes(report.verdict) && !onlyDependencies) {
    const message = `G3 ${report.verdict}: ${report.checks
      .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
      .map((c) => `${c.id}: ${c.summary}`)
      .join("; ")}.`;
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G3" };
    });
    return {
      kind: "blocked",
      gate: "G3",
      message: `${message} Run /frontsmith:next ${env.feature} to have the architect fix it.`,
    };
  }
  const owed = approvalToLeave(await readState(env), "plan");
  if (owed)
    return {
      kind: "waiting",
      reason: "approval",
      message: `Plan ready (G3 ${report.verdict}${onlyDependencies ? `; ${plan.dependencies.length} new dependenc${plan.dependencies.length === 1 ? "y" : "ies"} to approve with it` : ""}). Review plan.md and tasks.md, then approve it.`,
      command: approvalCommand(env.feature, owed),
    };
  if (onlyDependencies)
    return {
      kind: "waiting",
      reason: "approval",
      message: "The plan lists new dependencies that need approval.",
      command: approvalCommand(env.feature, "dependency", plan.dependencies[0]?.name),
    };
  await advance(env);
  return { kind: "advanced", message: `Plan ready (G3 ${report.verdict}).` };
}
