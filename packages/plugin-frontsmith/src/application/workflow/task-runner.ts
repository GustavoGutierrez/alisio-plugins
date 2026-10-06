import type { FsRole } from "../../domain/agents/roster.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import type { PlanEnvelope, PlanTask } from "../../domain/envelopes/plan.js";
import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import type { TaskResultEnvelope } from "../../domain/envelopes/task-result.js";
import type { UiContractEnvelope } from "../../domain/envelopes/ui-contract.js";
import type { GateReport, Prepared } from "../../domain/gates/aggregate.js";
import { gateG5 } from "../../domain/gates/g5.js";
import { gateG6 } from "../../domain/gates/g6.js";
import { describeProtectedChanges, diffSnapshots } from "../../domain/protected.js";
import type { UnitContext } from "../../domain/rules/unit.js";
import type { FeatureState } from "../../domain/state/feature-state.js";
import type { PromptSection } from "../agents/prompts.js";
import { commandPrepared, runProjectCommand, selectTestCommand } from "../checks/commands-check.js";
import { runCustomGates } from "../checks/custom-gates.js";
import { detectStack } from "../detect/stack.js";
import {
  delegateChild,
  describeFailure,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readState,
  updateState,
  writePlain,
} from "./env.js";
import { bounceDecision } from "./loops.js";
import { clip, compact } from "./phases/shared.js";
import {
  architecturePrepared,
  blockedPrepared,
  isTestPath,
  onlyRules,
  rulesPrepared,
} from "./prepared.js";
import { loadCommandPlan } from "./project.js";
import { captureProtected, protectedFindings } from "./protected.js";
import { diffSince, snapshotWorkspace, type WorkSnapshot } from "./unit-diff.js";

/** The build agent of a layer (spec 5.1); custom layers need custom agents, which v1 does not load. */
export function roleForLayer(
  layer: string,
): Extract<FsRole, "implementer" | "data-engineer" | "test-engineer"> | undefined {
  if (layer === "ui") return "implementer";
  if (layer === "data") return "data-engineer";
  if (layer === "test") return "test-engineer";
  return undefined;
}

export const KNOWN_LAYERS = ["ui", "data", "test"] as const;

export type TaskRunResult =
  | { status: "done"; report: GateReport }
  | { status: "blocked"; message: string; report?: GateReport }
  | { status: "cancelled" };

/** The contract of a task: from the plan, or the stored contract of an L0, repair or remediation task. */
export async function taskContract(
  env: PhaseEnv,
  state: FeatureState,
  taskId: string,
): Promise<(PlanTask & { findings?: string[] }) | undefined> {
  const stored = state.taskContracts?.[taskId];
  if (stored) return stored;
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  return plan?.tasks.find((task) => task.id === taskId);
}

/**
 * B-12: an L0 task is derived at run time from the intent, with no files or criteria declared; its
 * scope guard allows any path under `paths.sourceRoots` and the changed paths are recorded.
 * TODO(owner): B-12 confirm or specify how an L0 task contract is produced.
 */
export function l0Contract(state: FeatureState): PlanTask {
  return {
    id: "T-001",
    title: state.intent.slice(0, 120) || "L0 task",
    goal: state.intent,
    layer: "ui",
    files: [],
    acceptanceCriteria: [],
    tests: [],
    validation: ["typecheck", "lint", "testRelated"],
    constraints: ["Change only what the instruction needs."],
    dependsOn: [],
    stopConditions: [
      "The instruction is ambiguous.",
      "A file outside the source roots must change.",
    ],
    tdd: "exempt",
    tddExemptReason: "L0 trivial",
  };
}

async function sectionsFor(
  env: PhaseEnv,
  state: FeatureState,
  task: PlanTask & { findings?: string[] },
  previous: GateReport | undefined,
): Promise<PromptSection[]> {
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  const out: PromptSection[] = [{ title: "Task contract", body: compact(task) }];
  if (state.level === "L0") out.push({ title: "Instruction", body: state.intent });
  if (spec && task.acceptanceCriteria.length > 0)
    out.push({
      title: "Acceptance criteria of this task",
      body: compact(
        spec.acceptanceCriteria.filter((ac) => task.acceptanceCriteria.includes(ac.id)),
      ),
    });
  if (contract && task.layer === "ui")
    out.push({
      title: "UI contract excerpt",
      body: clip(
        compact({
          elements: contract.elements,
          stateMatrix: contract.stateMatrix,
          interactions: contract.interactions,
          focusOrder: contract.focusOrder,
          fidelityRules: contract.fidelityRules.map((r) => ({
            id: r.id,
            requirement: r.requirement,
          })),
        }),
        9000,
      ),
    });
  if (plan) {
    const components = plan.components.filter((c) => task.files.includes(c.path));
    if (components.length > 0)
      out.push({ title: "Plan excerpt (components of this task)", body: compact(components) });
    if (plan.state.length > 0) out.push({ title: "State ownership", body: compact(plan.state) });
    if (plan.contracts.length > 0 && task.layer === "data")
      out.push({
        title: "Contracts",
        body: compact({ contracts: plan.contracts, errors: plan.errors }),
      });
  }
  const context = await env.deps.rules.loadContext(env.root, state.level);
  out.push({
    title: "Rules that apply (ids and titles)",
    body:
      context.resolved.rules
        .filter((r) => r.kind !== "advisory")
        .slice(0, 120)
        .map((r) => `- ${r.id} ${r.title}`)
        .join("\n") || "None.",
  });
  const answered = state.questions.filter((q) => q.answer);
  if (answered.length > 0)
    out.push({
      title: "Answers from the person",
      body: answered.map((q) => `- ${q.id} ${q.question}\n  Answer: ${q.answer}`).join("\n"),
    });
  if (previous) {
    const lines = previous.findings
      .filter((f) => f.status === "FAIL" || f.status === "BLOCKED")
      .slice(0, 30)
      .map(
        (f) =>
          `- ${f.id} ${f.ruleId}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.message}`,
      );
    out.push({
      title: "Your previous attempt failed the gate; fix exactly these",
      body: lines.join("\n") || "See the failing checks.",
    });
  }
  if (task.findings && task.findings.length > 0)
    out.push({
      title: "Findings this task must fix",
      body: task.findings.map((f) => `- ${f}`).join("\n"),
    });
  return out;
}

export interface EvaluateInput {
  env: PhaseEnv;
  state: FeatureState;
  task: PlanTask;
  envelope: TaskResultEnvelope;
  before: WorkSnapshot;
  protectedBefore: Awaited<ReturnType<typeof captureProtected>>;
  /** Accumulated paths of the task so far (bounces). */
}

export async function evaluateG6({
  env,
  state,
  task,
  envelope,
  before,
  protectedBefore,
}: EvaluateInput): Promise<{ report: GateReport; changed: string[] }> {
  const { deps, root } = env;
  const lenient = state.taskContracts?.[task.id] !== undefined;
  const afterProtected = await captureProtected(deps, {
    root,
    artifactPaths: Object.keys(state.protected).filter((p) => !p.startsWith(".frontsmith/")),
    approvedDependencies: Object.keys(state.approvals.dependencies),
  });
  const changes = diffSnapshots(protectedBefore, afterProtected);
  const protectedFiles: Prepared =
    changes.length === 0
      ? { status: "PASS", summary: "protected files unchanged" }
      : {
          status: "FAIL",
          summary:
            describeProtectedChanges(changes, env.feature).split("\n")[1] ??
            "protected files changed",
          findings: protectedFindings(changes),
        };
  const refuse =
    changes.length > 0
      ? "FS-GOV-001 is open; commands derived from config or package scripts do not run"
      : undefined;

  const unitChanges = before.isRepo ? await diffSince(env, before) : undefined;
  const changed = (unitChanges ?? []).map((c) => c.path);
  const live = (unitChanges ?? []).filter((c) => c.status !== "D").map((c) => c.path);

  const mismatch = envelope.taskId !== task.id;
  const envelopePrepared: Prepared = mismatch
    ? {
        status: "FAIL",
        summary: `the envelope answers ${envelope.taskId}, not ${task.id}`,
        findings: [
          {
            ruleId: "ENV-TASK",
            severity: "major",
            status: "FAIL",
            kind: "deterministic",
            message: `The envelope names task ${envelope.taskId} but the unit is ${task.id}.`,
          },
        ],
      }
    : { status: "PASS", summary: "envelope valid" };

  // Rules (diff guards included) on the changed files; the scope guard is reported as its own check.
  let rules: Prepared | undefined;
  let scope: Prepared;
  if (!unitChanges) {
    scope = blockedPrepared("git is required to compute the unit diff", "FS-GOV-005");
    rules = undefined;
  } else if (live.length === 0 && unitChanges.length === 0) {
    scope = {
      status: "REVIEW",
      summary: "the task changed no files",
      findings: [
        {
          ruleId: "FS-GOV-005",
          severity: "minor",
          status: "REVIEW",
          kind: "heuristic",
          message: `${task.id} reports done but changed no files.`,
        },
      ],
    };
    rules = { status: "PASS", summary: "no changed files" };
  } else {
    const config = env.config;
    const unit: Omit<UnitContext, "rules"> = {
      changes: unitChanges,
      taskFiles: task.files,
      testPaths: task.tests.map((t) => t.path),
      allowedGeneratedPaths: [],
      scope: state.level === "L0" || lenient ? "l0" : "task",
      sourceRoots: config.paths.sourceRoots,
      protectedGlobs: [".frontsmith/**"],
      approvedDependencies: Object.keys(state.approvals.dependencies),
    };
    const outcome = await deps.rules.check(root, {
      paths: live.length > 0 ? live : ["__none__"],
      level: state.level,
      unit,
    });
    if (outcome.blocked) {
      rules = blockedPrepared(
        `rules could not be evaluated: ${outcome.context.problems.slice(0, 3).join("; ")}`,
        "G-RULES",
      );
      scope = { status: "SKIPPED", summary: "rules could not be evaluated", required: false };
    } else {
      rules = rulesPrepared(outcome.result, new Set(["FS-GOV-005"]));
      scope = onlyRules(outcome.result, new Set(["FS-GOV-005"]), "scope");
    }
  }

  // Architecture on the changed files.
  const architectureConfig = await deps.project.readArchitecture(root);
  let architecture: Prepared | undefined;
  if (architectureConfig.config && live.length > 0) {
    const outcome = await deps.architecture.check(root, { paths: live });
    architecture =
      outcome.state === "ok"
        ? architecturePrepared(outcome.result)
        : blockedPrepared("the architecture check could not run");
  } else if (architectureConfig.config)
    architecture = { status: "PASS", summary: "no source files changed" };

  // Project commands.
  const stack = await detectStack(deps.fsFor(root), deps.resolver);
  const plan = await loadCommandPlan(env, stack);
  const timeoutMs = env.config.limits.commandTimeoutMs;
  const cmdDeps = { process: deps.process, writer: deps.writer };
  const run = async (name: "typecheck" | "lint"): Promise<Prepared | undefined> => {
    const planned = plan[name];
    if (!planned) return undefined;
    return commandPrepared(
      await runProjectCommand(cmdDeps, {
        root,
        name,
        argv: planned.argv,
        source: planned.source,
        timeoutMs,
        signal: env.signal,
        logPath: `${env.evidenceDir}/${task.id}-${name}.log`,
        ...(refuse ? { refuse } : {}),
      }),
    );
  };
  const typecheck = await run("typecheck");
  const lint = await run("lint");
  const selected = selectTestCommand(
    plan,
    live.filter((p) => !p.endsWith(".md")),
  );
  const tests = selected
    ? commandPrepared(
        await runProjectCommand(cmdDeps, {
          root,
          name: selected.name,
          argv: selected.argv,
          source: selected.source,
          timeoutMs,
          signal: env.signal,
          logPath: `${env.evidenceDir}/${task.id}-tests.log`,
          ...(refuse ? { refuse } : {}),
        }),
      )
    : undefined;

  // Test-first evidence when the task requires it.
  let testFirst: Prepared | undefined;
  if (task.tdd === "required") {
    const problems: string[] = [];
    if (!changed.some(isTestPath)) problems.push("no test file changed");
    if (!envelope.testFirst || envelope.testFirst.failingOutputExcerpt.trim() === "")
      problems.push("the envelope has no failing-run excerpt");
    testFirst =
      problems.length === 0
        ? {
            status: "PASS",
            summary:
              "a test changed and a failing run was reported; the related tests re-ran green",
          }
        : {
            status: "FAIL",
            summary: problems.join("; "),
            findings: problems.map((message) => ({
              ruleId: "TDD-001",
              severity: "major" as const,
              status: "FAIL" as const,
              kind: "deterministic" as const,
              message: `Test-first is required: ${message}.`,
            })),
          };
  }

  const custom = await runCustomGates(cmdDeps, {
    root,
    gates: env.config.gates.custom,
    phase: "build",
    defaultTimeoutMs: timeoutMs,
    logDir: env.evidenceDir,
    signal: env.signal,
    ...(refuse ? { refuse } : {}),
  });

  const outcome = gateG6({
    envelope: envelopePrepared,
    protectedFiles,
    scope,
    rules,
    architecture,
    architectureConfigured: architectureConfig.config !== undefined,
    commands: { typecheck, lint, tests },
    testFirst,
    custom,
  });
  const report = await finishGate(env, "G6", outcome, { taskId: task.id });
  return { report, changed };
}

/** Register questions a child raised; ids that collide with existing ones get the next free number. */
async function registerQuestions(
  env: PhaseEnv,
  questions: TaskResultEnvelope["questions"],
): Promise<string[]> {
  const added: string[] = [];
  await updateState(env, (draft) => {
    const used = new Set(draft.questions.map((q) => q.id));
    let next = 1;
    for (const q of questions) {
      let id = q.id;
      if (used.has(id)) {
        while (used.has(`Q-${String(next).padStart(2, "0")}`)) next += 1;
        id = `Q-${String(next).padStart(2, "0")}`;
      }
      used.add(id);
      draft.questions.push({ id, question: q.question, blocking: true });
      added.push(id);
    }
  });
  return added;
}

/**
 * Run one build task (spec 7.2, 7.3): G5, then the child, then G6, bouncing a failing G6 back to the
 * same child session up to `maxBounces` times.
 */
export async function runTask(env: PhaseEnv, taskId: string): Promise<TaskRunResult> {
  let state = await readState(env);
  const task = await taskContract(env, state, taskId);
  const entry = state.tasks.find((t) => t.id === taskId);
  if (!task || !entry) return { status: "blocked", message: `Unknown task ${taskId}.` };
  const block = async (message: string, report?: GateReport): Promise<TaskRunResult> => {
    await updateState(env, (draft) => {
      const t = draft.tasks.find((x) => x.id === taskId);
      if (t) t.status = "blocked";
      draft.blocked = {
        reason: message,
        at: env.deps.clock.now().toISOString(),
        task: taskId,
        ...(report ? { gate: report.gate } : {}),
      };
    });
    return { status: "blocked", message, ...(report ? { report } : {}) };
  };

  const dependencyStatus = Object.fromEntries(state.tasks.map((t) => [t.id, t.status]));
  const lenient = state.taskContracts?.[taskId] !== undefined;
  const g5 = await finishGate(
    env,
    "G5",
    gateG5({
      task,
      sourceRoots: env.config.paths.sourceRoots,
      dependencyStatus,
      l0: lenient,
      limits: {
        maxTaskFiles: env.config.limits.maxTaskFiles,
        maxTaskCriteria: env.config.limits.maxTaskCriteria,
      },
      knownLayers: [...KNOWN_LAYERS],
    }),
    { taskId },
  );
  if (!passes(g5.verdict))
    return block(
      `${taskId} failed G5: ${g5.checks
        .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
        .map((c) => `${c.id}: ${c.summary}`)
        .join("; ")}.`,
      g5,
    );
  const role = roleForLayer(task.layer);
  if (!role) return block(`No agent builds layer ${task.layer}.`);

  await updateState(env, (draft) => {
    const t = draft.tasks.find((x) => x.id === taskId);
    if (t) t.status = "running";
    delete draft.blocked;
  });
  state = await readState(env);
  const protectedBefore = await captureProtected(env.deps, {
    root: env.root,
    artifactPaths: Object.keys(state.protected).filter((p) => !p.startsWith(".frontsmith/")),
    approvedDependencies: Object.keys(state.approvals.dependencies),
  });
  const before = await snapshotWorkspace(env);

  let previous: GateReport | undefined;
  let sessionId = entry.childSessionId;
  for (;;) {
    env.progress(`${taskId} ${role}: running`);
    const outcome = await delegateChild(env, {
      role,
      kind: "task-result",
      title: `${taskId} ${role}`,
      ...(role === "test-engineer" ? { mode: "build" as const } : {}),
      ...(sessionId ? { reuseSession: sessionId } : {}),
      sections: await sectionsFor(env, state, task, previous),
    });
    if (outcome.status === "cancelled") {
      await updateState(env, (draft) => {
        const t = draft.tasks.find((x) => x.id === taskId);
        if (t) t.status = "pending";
      });
      return { status: "cancelled" };
    }
    if (outcome.status !== "ok") return block(`${taskId}: ${describeFailure(outcome)}`);
    sessionId = outcome.sessionId ?? sessionId;
    const envelope = outcome.value;
    await updateState(env, (draft) => {
      const t = draft.tasks.find((x) => x.id === taskId);
      if (t && sessionId) t.childSessionId = sessionId;
    });
    if (envelope.status !== "done") {
      const ids = await registerQuestions(env, envelope.questions);
      const text = envelope.questions.map((q, i) => `${ids[i] ?? q.id}: ${q.question}`).join("; ");
      return block(
        `${taskId} is ${envelope.status === "blocked" ? "blocked" : "waiting for clarification"}${text ? `: ${text}` : `: ${envelope.summary}`}. Answer with /frontsmith:answer ${env.feature} <Q-id> -- <answer>.`,
      );
    }
    await writePlain(env, `results/${taskId}.json`, canonicalJson(envelope));
    state = await readState(env);
    const { report, changed } = await evaluateG6({
      env,
      state,
      task,
      envelope,
      before,
      protectedBefore,
    });
    if (passes(report.verdict)) {
      await updateState(env, (draft) => {
        const t = draft.tasks.find((x) => x.id === taskId);
        if (t) {
          t.status = "done";
          t.changedPaths = changed;
        }
        delete draft.blocked;
      });
      return { status: "done", report };
    }
    if (report.verdict === "BLOCKED")
      return block(
        `${taskId} G6 BLOCKED: ${report.checks
          .filter((c) => c.status === "BLOCKED")
          .map((c) => `${c.id}: ${c.summary}`)
          .join("; ")}.`,
        report,
      );
    const decision = bounceDecision({
      bounces: state.tasks.find((t) => t.id === taskId)?.bounces ?? 0,
      max: env.config.limits.maxBounces,
    });
    if (decision.action === "blocked")
      return block(
        `${taskId} failed G6 and is blocked: ${decision.reason}. Inspect docs reports ${report.gate}-${taskId}.json.`,
        report,
      );
    await updateState(env, (draft) => {
      const t = draft.tasks.find((x) => x.id === taskId);
      if (t) t.bounces = decision.attempt;
    });
    env.progress(`${taskId}: bounce ${decision.attempt} of ${env.config.limits.maxBounces}`);
    previous = report;
  }
}
