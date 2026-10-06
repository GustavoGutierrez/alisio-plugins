import type { PlanEnvelope } from "../../domain/envelopes/plan.js";
import { validateEnvelope } from "../../domain/envelopes/registry.js";
import type { ReviewEnvelope } from "../../domain/envelopes/review.js";
import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import type { TaskResultEnvelope } from "../../domain/envelopes/task-result.js";
import type { TestMapEnvelope } from "../../domain/envelopes/test-map.js";
import type { TokensEnvelope } from "../../domain/envelopes/tokens.js";
import type { UiContractEnvelope } from "../../domain/envelopes/ui-contract.js";
import type { GateReport } from "../../domain/gates/aggregate.js";
import { gateG1 } from "../../domain/gates/g1.js";
import { gateG2 } from "../../domain/gates/g2.js";
import { gateG2T } from "../../domain/gates/g2t.js";
import { gateG4 } from "../../domain/gates/g4.js";
import { gateG5 } from "../../domain/gates/g5.js";
import { gateG8 } from "../../domain/gates/g8.js";
import type { GateId } from "../../domain/state/feature-state.js";
import {
  artifactDirOf,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  readJson,
  readState,
} from "./env.js";
import { evaluateAcceptance } from "./phases/accept.js";
import { gatherContext } from "./phases/context.js";
import { evaluatePlanGate } from "./phases/plan.js";
import { namingProblems } from "./phases/tokens.js";
import { referenceStatuses } from "./phases/ui-contract.js";
import { evaluateG7 } from "./phases/validate.js";
import { captureProtected } from "./protected.js";
import { evaluateG6, KNOWN_LAYERS, taskContract } from "./task-runner.js";

export class GateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateCheckError";
  }
}

/**
 * `/frontsmith:check`, `fs_gate_run` and the CLI `gate` command (spec 7.2): evaluate one gate on the
 * artifacts and the workspace as they are now, persist the report, and return it. No child runs.
 */
export async function checkGate(env: PhaseEnv, gate: GateId, taskId?: string): Promise<GateReport> {
  const state = await readState(env);
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined)
      throw new GateCheckError(`${gate} needs ${what}, which ${env.feature} does not have yet.`);
    return value;
  };
  const spec = await loadArtifact<SpecEnvelope>(env, state, "spec-json");
  switch (gate) {
    case "G0":
      return finishGate(env, "G0", (await gatherContext(env)).outcome);
    case "G1":
      return finishGate(
        env,
        "G1",
        gateG1({ spec: need(spec, "a spec"), questions: state.questions }),
      );
    case "G2": {
      const contract = need(
        await loadArtifact<UiContractEnvelope>(env, state, "ui-contract"),
        "a UI contract",
      );
      return finishGate(
        env,
        "G2",
        gateG2({
          contract,
          spec: need(spec, "a spec"),
          mode: state.mode,
          references: await referenceStatuses(env, contract),
        }),
      );
    }
    case "G2T": {
      const envelope = need(
        await readJson<TokensEnvelope>(
          env,
          `${artifactDirOf(env.config, env.feature)}/tokens-envelope.json`,
        ),
        "a tokens result",
      );
      const checked = await env.deps.tokens.check(env.root);
      const pairs = checked.blocked
        ? []
        : checked.rows
            .filter((r) => r.ratio !== null)
            .map((r) => ({
              fg: r.fg,
              bg: r.bg,
              theme: r.theme,
              ratio: r.ratio as number,
              minimum: r.minimum,
            }));
      return finishGate(
        env,
        "G2T",
        gateG2T({
          namingProblems: namingProblems(envelope),
          solver: { status: "skipped", reason: "checked on the stored values" },
          pairs,
          lockedViolations: [],
        }),
      );
    }
    case "G3": {
      const plan = need(await loadArtifact<PlanEnvelope>(env, state, "plan-json"), "a plan");
      return finishGate(env, "G3", await evaluatePlanGate(env, plan, need(spec, "a spec")));
    }
    case "G4": {
      const plan = need(await loadArtifact<PlanEnvelope>(env, state, "plan-json"), "a plan");
      const testMap = need(
        await loadArtifact<TestMapEnvelope>(env, state, "test-map"),
        "a test map",
      );
      const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
      return finishGate(
        env,
        "G4",
        gateG4({ spec: need(spec, "a spec"), plan, testMap, ...(contract ? { contract } : {}) }),
      );
    }
    case "G5":
    case "G6": {
      const id = need(
        taskId ?? state.tasks.find((t) => t.status !== "done")?.id ?? state.tasks[0]?.id,
        "a task (use --task T-001)",
      );
      const task = need(await taskContract(env, state, id), `task ${id}`);
      if (gate === "G5")
        return finishGate(
          env,
          "G5",
          gateG5({
            task,
            sourceRoots: env.config.paths.sourceRoots,
            dependencyStatus: Object.fromEntries(state.tasks.map((t) => [t.id, t.status])),
            l0: state.taskContracts?.[id] !== undefined,
            limits: {
              maxTaskFiles: env.config.limits.maxTaskFiles,
              maxTaskCriteria: env.config.limits.maxTaskCriteria,
            },
            knownLayers: [...KNOWN_LAYERS],
          }),
          { taskId: id },
        );
      const stored = await readJson<unknown>(
        env,
        `${artifactDirOf(env.config, env.feature)}/results/${id}.json`,
      );
      const parsed = validateEnvelope("task-result", stored);
      if (!parsed.ok)
        throw new GateCheckError(`G6 needs the stored result of ${id}; run the task first.`);
      const envelope: TaskResultEnvelope = parsed.value;
      const protectedNow = await captureProtected(env.deps, {
        root: env.root,
        artifactPaths: Object.keys(state.protected).filter((p) => !p.startsWith(".frontsmith/")),
        approvedDependencies: Object.keys(state.approvals.dependencies),
      });
      const before = {
        isRepo: await env.deps.git.isRepo(env.root),
        hashes: new Map<string, string>(),
        texts: new Map<string, string>(),
      };
      return (
        await evaluateG6({ env, state, task, envelope, before, protectedBefore: protectedNow })
      ).report;
    }
    case "G7":
      return evaluateG7(env);
    case "G8": {
      const reviews = need(
        await readJson<ReviewEnvelope[]>(
          env,
          `${artifactDirOf(env.config, env.feature)}/reviews.json`,
        ),
        "review results",
      );
      return finishGate(env, "G8", gateG8({ level: state.level, reviews }));
    }
    case "G9":
      need(spec, "a spec");
      return evaluateAcceptance(env);
  }
}
