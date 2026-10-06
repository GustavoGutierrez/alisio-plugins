import type { PlanEnvelope, PlanTask } from "../../../domain/envelopes/plan.js";
import type { TestMapEnvelope } from "../../../domain/envelopes/test-map.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import type { GateReport, Prepared } from "../../../domain/gates/aggregate.js";
import { gateG7 } from "../../../domain/gates/g7.js";
import type { UnitContext } from "../../../domain/rules/unit.js";
import type { FeatureState } from "../../../domain/state/feature-state.js";
import { budgetPrepared, runBudgetCheck } from "../../checks/budget-check.js";
import { commandPrepared, runProjectCommand } from "../../checks/commands-check.js";
import { runCustomGates } from "../../checks/custom-gates.js";
import { detectStack } from "../../detect/stack.js";
import {
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readState,
  type UnitResult,
  updateState,
} from "../env.js";
import { groupFindingsByFile, repairDecision } from "../loops.js";
import { architecturePrepared, blockedPrepared, rulesPrepared } from "../prepared.js";
import { loadCommandPlan } from "../project.js";
import { runTask } from "../task-runner.js";
import { advance } from "./shared.js";

/** Paths the feature changed, from the tasks that passed G6. */
export const featurePaths = (state: FeatureState): string[] => [
  ...new Set(state.tasks.flatMap((t) => t.changedPaths)),
];

/** The diff of the whole feature against HEAD, for the diff guards of G7 (spec 7.2). */
export async function featureUnit(
  env: PhaseEnv,
  state: FeatureState,
  plan: PlanEnvelope | undefined,
): Promise<Omit<UnitContext, "rules"> | undefined> {
  const { git } = env.deps;
  if (!(await git.isRepo(env.root))) return undefined;
  const fs = env.deps.fsFor(env.root);
  const changes: UnitContext["changes"] = [];
  for (const path of featurePaths(state)) {
    const before = await git.show(env.root, "HEAD", path);
    const read = await fs.read(path);
    const after = read.kind === "text" ? read.text : undefined;
    changes.push({
      path,
      status: before === undefined ? "A" : after === undefined ? "D" : "M",
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  const extra = Object.values(state.taskContracts ?? {}).flatMap((t) => t.files);
  const generated = state.tasks.filter((t) => t.origin !== "plan").flatMap((t) => t.changedPaths);
  return {
    changes,
    taskFiles: [
      ...new Set([...(plan?.tasks.flatMap((t) => t.files) ?? []), ...extra, ...generated]),
    ],
    testPaths: plan?.tasks.flatMap((t) => t.tests.map((x) => x.path)) ?? [],
    allowedGeneratedPaths: [],
    scope: state.level === "L0" ? "l0" : "task",
    sourceRoots: env.config.paths.sourceRoots,
    protectedGlobs: [".frontsmith/**"],
    approvedDependencies: Object.keys(state.approvals.dependencies),
  };
}

/** Evaluate gate G7 for the current state of the workspace (spec 7.2). */
export async function evaluateG7(env: PhaseEnv): Promise<GateReport> {
  const { deps, root } = env;
  const state = await readState(env);
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  const testMap = await loadArtifact<TestMapEnvelope>(env, state, "test-map");
  const paths = featurePaths(state);

  // Rule packs on the feature scope, with the diff guards over the feature diff.
  let rules: Prepared | undefined;
  const unit = await featureUnit(env, state, plan);
  if (paths.length === 0) rules = { status: "PASS", summary: "the feature changed no files" };
  else {
    const outcome = await deps.rules.check(root, {
      paths: paths.filter((p) => state.tasks.some((t) => t.changedPaths.includes(p))),
      level: state.level,
      ...(unit ? { unit } : {}),
    });
    rules = outcome.blocked
      ? blockedPrepared(
          `rules could not be evaluated: ${outcome.context.problems.slice(0, 3).join("; ")}`,
          "G-RULES",
        )
      : rulesPrepared(outcome.result);
  }

  const architectureConfig = await deps.project.readArchitecture(root);
  let architecture: Prepared | undefined;
  if (architectureConfig.config) {
    const outcome = await deps.architecture.check(
      root,
      state.level === "L0" || state.level === "L1"
        ? { paths: paths.length > 0 ? paths : ["__none__"] }
        : {},
    );
    architecture =
      outcome.state === "ok"
        ? architecturePrepared(outcome.result)
        : blockedPrepared("the architecture check could not run");
  }

  const stack = await detectStack(deps.fsFor(root), deps.resolver);
  const plan_ = await loadCommandPlan(env, stack);
  const cmdDeps = { process: deps.process, writer: deps.writer };
  const timeoutMs = env.config.limits.commandTimeoutMs;
  const command = async (name: "test" | "build" | "e2e"): Promise<Prepared | undefined> => {
    const planned = plan_[name];
    if (!planned) return undefined;
    return commandPrepared(
      await runProjectCommand(cmdDeps, {
        root,
        name,
        argv: planned.argv,
        source: planned.source,
        timeoutMs,
        signal: env.signal,
        logPath: `${env.evidenceDir}/G7-${name}.log`,
      }),
    );
  };
  const e2eInTestMap = testMap?.entries.some((e) => e.levels.includes("e2e")) ?? false;
  const test = await command("test");
  const build = state.level === "L2" || state.level === "L3" ? await command("build") : undefined;
  const e2e = state.level === "L3" || e2eInTestMap ? await command("e2e") : undefined;

  const fidelityRequired = (contract?.fidelityRules.length ?? 0) > 0;
  const contractPath = state.artifacts["ui-contract"]?.path;
  let fidelity: Prepared | undefined;
  let a11y: Prepared | undefined;
  if (contractPath && deps.fidelity) {
    if (fidelityRequired)
      fidelity = await deps.fidelity.run({
        root,
        feature: env.feature,
        contractPath,
        runId: env.evidenceDir.split("/").pop() ?? "run",
        signal: env.signal,
      });
    // Runtime accessibility is mandatory at L3; below that it runs when the project can run it.
    if (
      contract &&
      contract.cases.length > 0 &&
      (state.level === "L3" || stack.playwrightResolvable)
    ) {
      const ran = await deps.fidelity.a11y({
        root,
        feature: env.feature,
        contractPath,
        runId: `${env.evidenceDir.split("/").pop() ?? "run"}-a11y`,
        signal: env.signal,
      });
      a11y = { ...ran, required: state.level === "L3" };
    }
  }
  const budgets = budgetPrepared(
    await runBudgetCheck(
      { fsFor: deps.fsFor, assets: deps.assets, rules: deps.rules },
      { root, strictDelta: state.level === "L2" || state.level === "L3" },
    ),
  );
  const custom = await runCustomGates(cmdDeps, {
    root,
    gates: env.config.gates.custom,
    phase: "validate",
    defaultTimeoutMs: timeoutMs,
    logDir: env.evidenceDir,
    signal: env.signal,
  });
  return finishGate(
    env,
    "G7",
    gateG7({
      level: state.level,
      rules,
      architecture,
      architectureConfigured: architectureConfig.config !== undefined,
      commands: { test, build, e2e },
      e2eInTestMap,
      fidelityRequired,
      fidelity,
      a11yRequired: state.level === "L3",
      a11y,
      budgets,
      audit: undefined,
      custom,
    }),
  );
}

const nextTaskId = (state: FeatureState): string => {
  const max = Math.max(0, ...state.tasks.map((t) => Number(t.id.slice(2))));
  return `T-${String(max + 1).padStart(3, "0")}`;
};

/** Turn failing findings into repair or remediation tasks, one per file (spec 7.3). */
export async function createFixTasks(
  env: PhaseEnv,
  report: GateReport,
  origin: "repair" | "remediation",
  statuses: ReadonlySet<string> = new Set(["FAIL"]),
): Promise<string[]> {
  const state = await readState(env);
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const layerOf = (file: string | undefined): string =>
    (file && plan?.tasks.find((t) => t.files.includes(file))?.layer) || "ui";
  const failing = report.findings.filter((f) => statuses.has(f.status));
  const groups = groupFindingsByFile(
    failing.map((f) => ({ id: f.id, ...(f.file ? { file: f.file } : {}) })),
  );
  const created: string[] = [];
  await updateState(env, (draft) => {
    for (const group of groups) {
      const id = nextTaskId(draft);
      const findings = group.findingIds.map((fid) => {
        const f = failing.find((x) => x.id === fid);
        return `${fid} ${f?.ruleId ?? ""}${f?.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f?.message ?? ""}`;
      });
      const layer = layerOf(group.file);
      const contract: PlanTask & { findings?: string[] } = {
        id,
        title: group.file ? `${origin} ${group.file}` : `${origin} findings without a file`,
        goal: `Fix the listed findings${group.file ? ` in ${group.file}` : ""} without changing behaviour that is already correct.`,
        layer,
        files: group.file ? [group.file] : [],
        acceptanceCriteria: [],
        tests: [],
        validation: ["typecheck", "lint", "testRelated"],
        constraints: ["Fix only the listed findings.", "Do not weaken or delete tests."],
        dependsOn: [],
        stopConditions: ["A finding cannot be fixed without changing the spec."],
        tdd: "exempt",
        tddExemptReason: `${origin} task`,
        findings,
      };
      draft.tasks.push({ id, layer, status: "pending", bounces: 0, changedPaths: [], origin });
      draft.taskContracts = { ...(draft.taskContracts ?? {}), [id]: contract };
      created.push(id);
    }
  });
  return created;
}

/** Validate phase (spec 7.2 G7, 7.3): validation, then bounded repair rounds while findings decrease. */
export async function runValidate(env: PhaseEnv): Promise<UnitResult> {
  let previous: GateReport | undefined;
  let previousFailures: number | undefined;
  for (;;) {
    env.progress("validate: running G7");
    const report = await evaluateG7(env);
    if (passes(report.verdict)) {
      await advance(env);
      return { kind: "advanced", message: `Validation passed (G7 ${report.verdict}).` };
    }
    if (report.verdict === "BLOCKED")
      return blockValidation(
        env,
        `G7 BLOCKED: ${report.checks
          .filter((c) => c.status === "BLOCKED")
          .map((c) => `${c.id}: ${c.summary}`)
          .join("; ")}.`,
      );
    const failures = report.findings.filter((f) => f.status === "FAIL").length;
    const state = await readState(env);
    const decision = repairDecision({
      round: state.counters.repairRounds,
      max: env.config.limits.maxRepairRounds,
      previousFailures,
      failures,
    });
    if (decision.action === "stop")
      return blockValidation(
        env,
        `G7 FAIL kept: ${decision.message}.${previous ? ` Compare ${previous.gate} reports ${previous.generatedAt} and ${report.generatedAt}.` : ""}`,
      );
    if (decision.action === "done") continue;
    env.progress(`validate: repair round ${decision.round}`);
    await updateState(env, (draft) => {
      draft.counters.repairRounds = decision.round;
    });
    const ids = await createFixTasks(env, report, "repair");
    for (const id of ids) {
      const result = await runTask(env, id);
      if (result.status === "cancelled")
        return { kind: "cancelled", message: "validate was cancelled." };
      if (result.status === "blocked") return blockValidation(env, result.message);
    }
    previous = report;
    previousFailures = failures;
  }
}

async function blockValidation(env: PhaseEnv, message: string): Promise<UnitResult> {
  await updateState(env, (draft) => {
    draft.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G7" };
  });
  return { kind: "blocked", gate: "G7", message };
}
