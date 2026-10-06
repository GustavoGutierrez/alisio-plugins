import type { PlanEnvelope, PlanTask } from "../envelopes/plan.js";
import type { SpecEnvelope } from "../envelopes/spec.js";
import type { Level } from "../state/levels.js";
import { requirementsForLevel } from "../state/levels.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G3Input {
  plan: PlanEnvelope;
  spec: SpecEnvelope;
  level: Level;
  limits: { maxTaskFiles: number; maxTaskCriteria: number };
  /** Ids of the pattern catalog. */
  patternIds: ReadonlySet<string>;
  /** Contract files named by the plan: does the file exist, and (OpenAPI JSON only) its operation ids. */
  contractFiles: Readonly<Record<string, { exists: boolean; operations?: readonly string[] }>>;
  /** Problems from the planned-graph check: files without a layer, imports against the allowed direction. */
  plannedGraph: { architecturePresent: boolean; violations: string[] };
  /** Dependencies already approved by a person. */
  approvedDependencies: ReadonlySet<string>;
}

/** Task ids on a dependency cycle, empty when the graph is acyclic. */
export function dependencyCycle(tasks: readonly PlanTask[]): string[] {
  const edges = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let cycle: string[] = [];
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") {
      cycle = [...stack.slice(stack.indexOf(id)), id];
      return true;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) if (edges.has(next) && visit(next)) return true;
    stack.pop();
    state.set(id, "done");
    return false;
  };
  for (const task of tasks) if (visit(task.id)) return cycle;
  return [];
}

/** G3 Plan (spec 7.2). */
export function gateG3(input: G3Input): GateOutcome {
  const { plan, spec } = input;
  const b = new GateBuilder();
  b.add("schema", "PASS", "plan envelope valid");

  const mapped = new Set(plan.tasks.flatMap((task) => task.acceptanceCriteria));
  b.problems(
    "ac-mapping",
    "PLN-001",
    spec.acceptanceCriteria
      .filter((ac) => !mapped.has(ac.id))
      .map((ac) => `${ac.id} is not served by any task`),
    "every acceptance criterion has a task",
    { fix: "Add the criterion to a task or add a task for it." },
  );
  const knownAcs = new Set(spec.acceptanceCriteria.map((ac) => ac.id));
  b.problems(
    "ac-refs",
    "PLN-012",
    plan.tasks.flatMap((task) =>
      task.acceptanceCriteria
        .filter((id) => !knownAcs.has(id))
        .map((id) => `${task.id} names unknown criterion ${id}`),
    ),
    "tasks name existing criteria",
  );

  const ids = new Set(plan.tasks.map((task) => task.id));
  const missingDeps = plan.tasks.flatMap((task) =>
    task.dependsOn
      .filter((dep) => !ids.has(dep))
      .map((dep) => `${task.id} depends on unknown task ${dep}`),
  );
  const cycle = dependencyCycle(plan.tasks);
  b.problems(
    "dependencies-acyclic",
    "PLN-002",
    [...missingDeps, ...(cycle.length > 0 ? [`dependency cycle: ${cycle.join(" -> ")}`] : [])],
    "task dependencies are acyclic",
  );

  b.problems(
    "task-size",
    "PLN-004",
    plan.tasks.flatMap((task) => [
      ...(task.files.length > input.limits.maxTaskFiles
        ? [`${task.id} lists ${task.files.length} files (maximum ${input.limits.maxTaskFiles})`]
        : []),
      ...(task.acceptanceCriteria.length > input.limits.maxTaskCriteria
        ? [
            `${task.id} serves ${task.acceptanceCriteria.length} criteria (maximum ${input.limits.maxTaskCriteria})`,
          ]
        : []),
    ]),
    "tasks fit the size limits",
    { fix: "Split the task." },
  );

  if (input.plannedGraph.architecturePresent)
    b.problems(
      "planned-graph",
      "PLN-005",
      input.plannedGraph.violations,
      "planned files and imports respect the layers",
      {
        fix: "Move the file to the right layer or change the import direction.",
      },
    );
  else b.add("planned-graph", "SKIPPED", "no architecture configuration", { required: false });

  b.problems(
    "patterns",
    "PLN-006",
    plan.components.flatMap((component) =>
      component.patterns
        .filter((id) => !input.patternIds.has(id))
        .map((id) => `${component.name} uses unknown pattern ${id}`),
    ),
    "patterns come from the catalog",
  );

  const contractProblems: string[] = [];
  for (const contract of plan.contracts) {
    const info = input.contractFiles[contract.file];
    if (!info?.exists) {
      contractProblems.push(`contract file ${contract.file} does not exist`);
      continue;
    }
    if (info.operations)
      for (const operation of contract.operations)
        if (!info.operations.includes(operation))
          contractProblems.push(`${contract.file} has no operationId ${operation}`);
  }
  b.problems("contracts", "PLN-007", contractProblems, "contract files and operations exist", {
    fix: "Never invent endpoints: fix the reference or ask for the contract.",
  });

  const unapproved = plan.dependencies.filter((dep) => !input.approvedDependencies.has(dep.name));
  if (unapproved.length === 0)
    b.add(
      "new-dependencies",
      "PASS",
      plan.dependencies.length === 0 ? "no new dependencies" : "all approved",
    );
  else {
    b.add(
      "new-dependencies",
      "BLOCKED",
      `${unapproved.length} dependenc${unapproved.length === 1 ? "y" : "ies"} awaiting approval`,
    );
    for (const dep of unapproved)
      b.finding(
        "new-dependencies",
        "PLN-009",
        "blocker",
        "BLOCKED",
        `${dep.name}@${dep.version}: ${dep.reason}`,
        {
          fix: `/frontsmith:approve <feature> dependency ${dep.name}`,
        },
      );
  }

  const required = requirementsForLevel(input.level);
  if (required.adrRequired || required.securityRiskRequired) {
    const problems: string[] = [];
    if (required.adrRequired && plan.adrs.length === 0)
      problems.push("L3 needs at least one decision record");
    if (
      required.securityRiskRequired &&
      !plan.risks.some((r) => r.category === "security" || r.category === "privacy")
    )
      problems.push("L3 needs at least one security or privacy risk");
    b.problems(
      "high-risk",
      "PLN-010",
      problems,
      "decision record and security or privacy risk present",
    );
  }

  if (input.level === "L1")
    b.add("architecture-config", "SKIPPED", "not required at L1 (B-13)", { required: false });
  else
    b.problems(
      "architecture-config",
      "PLN-011",
      input.plannedGraph.architecturePresent || plan.architectureConfig !== null
        ? []
        : ["no architecture configuration exists or is proposed"],
      "architecture configuration present or proposed",
      { fix: "Propose an architecture.json in the plan (architectureConfig)." },
    );
  return b.outcome;
}
