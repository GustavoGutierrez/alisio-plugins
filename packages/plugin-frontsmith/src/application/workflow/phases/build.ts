import type { PlanEnvelope } from "../../../domain/envelopes/plan.js";
import { loadArtifact, type PhaseEnv, readState, type UnitResult, updateState } from "../env.js";
import { l0Contract, runTask } from "../task-runner.js";
import { advance } from "./shared.js";

/** Create the task list of the build phase: the plan's tasks, or the single L0 task (B-12). */
async function materialiseTasks(env: PhaseEnv): Promise<string | undefined> {
  const state = await readState(env);
  if (state.tasks.length > 0) return undefined;
  if (state.level === "L0") {
    await updateState(env, (draft) => {
      draft.tasks.push({
        id: "T-001",
        layer: "ui",
        status: "pending",
        bounces: 0,
        changedPaths: [],
        origin: "l0",
      });
      draft.taskContracts = { ...(draft.taskContracts ?? {}), "T-001": l0Contract(draft) };
    });
    return undefined;
  }
  const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
  if (!plan) return "build needs the approved plan.";
  await updateState(env, (draft) => {
    for (const task of plan.tasks)
      draft.tasks.push({
        id: task.id,
        layer: task.layer,
        status: "pending",
        bounces: 0,
        changedPaths: [],
        origin: "plan",
      });
  });
  return undefined;
}

/**
 * Build phase (spec 7.5): the whole task loop in one unit. Tasks run in plan order once their
 * dependencies are done; a blocked task stops the loop with the reason.
 */
export async function runBuild(env: PhaseEnv): Promise<UnitResult> {
  const problem = await materialiseTasks(env);
  if (problem) return { kind: "blocked", message: problem };
  // A task left `running` by an interrupted unit starts over (artifacts are only written after validation).
  await updateState(env, (draft) => {
    for (const task of draft.tasks) if (task.status === "running") task.status = "pending";
  });
  for (;;) {
    const state = await readState(env);
    const done = new Set(state.tasks.filter((t) => t.status === "done").map((t) => t.id));
    const plan = await loadArtifact<PlanEnvelope>(env, state, "plan-json");
    const dependsOn = (id: string): string[] =>
      state.taskContracts?.[id]?.dependsOn ?? plan?.tasks.find((t) => t.id === id)?.dependsOn ?? [];
    const next = state.tasks.find(
      (t) => t.status === "pending" && dependsOn(t.id).every((d) => done.has(d)),
    );
    if (!next) {
      const blocked = state.tasks.filter((t) => t.status === "blocked");
      if (blocked.length > 0)
        return {
          kind: "blocked",
          message:
            `${blocked.map((t) => t.id).join(", ")} blocked. ${state.blocked?.reason ?? ""}`.trim(),
          ...(blocked[0] ? { task: blocked[0].id } : {}),
        };
      if (state.tasks.every((t) => t.status === "done")) break;
      return { kind: "blocked", message: "No task is ready: check the dependencies in the plan." };
    }
    const result = await runTask(env, next.id);
    if (result.status === "cancelled")
      return { kind: "cancelled", message: "build was cancelled." };
    if (result.status === "blocked")
      return { kind: "blocked", message: result.message, task: next.id };
  }
  await advance(env);
  return {
    kind: "advanced",
    message: `Build done: ${(await readState(env)).tasks.length} task(s) passed G6.`,
  };
}
