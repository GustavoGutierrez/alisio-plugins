import type { PlanTask } from "../envelopes/plan.js";
import { compileGlob } from "../glob.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G5Input {
  task: PlanTask;
  sourceRoots: readonly string[];
  /** Status of the tasks this one depends on, by id. */
  dependencyStatus: Readonly<Record<string, "pending" | "running" | "done" | "blocked">>;
  /** L0 derives its single task at run time: no files, no criteria (B-12). */
  l0: boolean;
  limits: { maxTaskFiles: number; maxTaskCriteria: number };
  /** Layers a build agent exists for. */
  knownLayers: readonly string[];
}

const inRoots = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => compileGlob(`${root.replace(/\/$/, "")}/**`)(path));

/** G5 Task (spec 7.2): the next unit is a complete, bounded contract. */
export function gateG5(input: G5Input): GateOutcome {
  const { task } = input;
  const b = new GateBuilder();
  const missing: string[] = [];
  if (task.goal.trim() === "") missing.push("goal");
  if (task.validation.length === 0 && !input.l0) missing.push("validation commands");
  if (!input.l0) {
    if (task.files.length === 0) missing.push("files");
    if (task.acceptanceCriteria.length === 0) missing.push("acceptance criteria");
  }
  b.problems(
    "contract",
    "TSK-001",
    missing.map((field) => `${task.id} has no ${field}`),
    "the task contract is complete",
  );
  const testPaths = new Set(task.tests.map((test) => test.path));
  b.problems(
    "files",
    "TSK-002",
    input.l0
      ? []
      : task.files
          .filter((file) => !inRoots(file, input.sourceRoots) && !testPaths.has(file))
          .map((file) => `${file} is outside the source roots`),
    "files are inside the source roots",
    { fix: "Keep task files under paths.sourceRoots or list them as tests." },
  );
  const blocked = task.dependsOn.filter((dep) => input.dependencyStatus[dep] !== "done");
  if (blocked.length === 0) b.add("dependencies", "PASS", "dependencies are done");
  else {
    b.add("dependencies", "BLOCKED", `waiting for ${blocked.join(", ")}`);
    for (const dep of blocked)
      b.finding(
        "dependencies",
        "TSK-003",
        "blocker",
        "BLOCKED",
        `${task.id} depends on ${dep}, which is not done.`,
      );
  }
  b.problems(
    "size",
    "TSK-004",
    input.l0
      ? []
      : [
          ...(task.files.length > input.limits.maxTaskFiles
            ? [`${task.id} has too many files`]
            : []),
          ...(task.acceptanceCriteria.length > input.limits.maxTaskCriteria
            ? [`${task.id} serves too many criteria`]
            : []),
        ],
    "within the size limits",
  );
  b.problems(
    "layer",
    "TSK-005",
    input.knownLayers.includes(task.layer) ? [] : [`no agent builds layer ${task.layer}`],
    "an agent exists for the layer",
  );
  return b.outcome;
}
