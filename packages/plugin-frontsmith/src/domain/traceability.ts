import type { PlanEnvelope } from "./envelopes/plan.js";
import type { SpecEnvelope } from "./envelopes/spec.js";
import type { TestMapEnvelope } from "./envelopes/test-map.js";
import type { Verdict } from "./verdict.js";

/** One row of the Requirement -> AC -> Task -> Test -> Evidence matrix (spec 2.1). */
export interface Trace {
  requirementId: string;
  acId: string;
  tasks: string[];
  tests: string[];
  /** PASS: automated evidence; MANUAL: a recorded manual verification only; MISSING: nothing. */
  status: "PASS" | "MANUAL" | "MISSING";
  note: string;
  evidence: string;
}

export interface ManualVerification {
  at: string;
  evidence: string;
}

export interface TraceInput {
  spec: SpecEnvelope;
  plan: PlanEnvelope | undefined;
  testMap: TestMapEnvelope | undefined;
  manual: Readonly<Record<string, ManualVerification>>;
  /** Done tasks whose last G6 passed, by id. */
  passedTasks: ReadonlySet<string>;
  /** The verdict of the latest G7 report. */
  validation: Verdict | undefined;
}

/**
 * Build the traceability matrix. An AC has PASS evidence when a task serving it is done with a
 * passing G6 and the latest G7 is not FAIL or BLOCKED; a recorded manual verification counts as
 * evidence of its own. Anything else is MISSING and G9 refuses it (spec 7.2 G9, 10.1).
 */
export function buildTrace(input: TraceInput): Trace[] {
  const entries = new Map((input.testMap?.entries ?? []).map((entry) => [entry.acId, entry]));
  return input.spec.acceptanceCriteria.map((ac) => {
    const tasks = (input.plan?.tasks ?? [])
      .filter((task) => task.acceptanceCriteria.includes(ac.id))
      .map((task) => task.id);
    const entry = entries.get(ac.id);
    const tests = entry?.tests.map((test) => test.path) ?? [];
    const manual = input.manual[ac.id];
    const doneAll = tasks.length > 0 && tasks.every((id) => input.passedTasks.has(id));
    const validated = input.validation === "PASS" || input.validation === "REVIEW";
    const base = { requirementId: ac.requirementId, acId: ac.id, tasks, tests };
    if (doneAll && validated)
      return {
        ...base,
        status: "PASS",
        note: "tasks passed their gate and validation passed",
        evidence: `tasks ${tasks.join(", ")}`,
      };
    if (manual)
      return {
        ...base,
        status: "MANUAL",
        note: "recorded manual verification",
        evidence: manual.evidence,
      };
    const why =
      tasks.length === 0
        ? "no task serves it"
        : !doneAll
          ? "a task is not done"
          : "validation has not passed";
    return { ...base, status: "MISSING", note: why, evidence: "" };
  });
}
