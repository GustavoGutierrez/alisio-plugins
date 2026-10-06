import { type EnvelopeResult, type OpenQuestion, openEnvelope, readQuestions } from "./parse.js";

export const taskStatuses = ["done", "blocked", "needs_clarification"] as const;

export interface TaskResultEnvelope {
  schemaVersion: 1;
  kind: "task-result";
  taskId: string;
  status: (typeof taskStatuses)[number];
  summary: string;
  changedPaths: string[];
  /** Claims are recorded, never trusted: G6 re-runs the commands itself (spec 9.2). */
  commands: Array<{ argv: string; exitCode: number; summary: string }>;
  testFirst: {
    testPath: string;
    failingOutputExcerpt: string;
    passingOutputExcerpt: string;
  } | null;
  acceptance: Array<{ acId: string; satisfiedBy: string[] }>;
  deviations: string[];
  questions: OpenQuestion[];
  /** TODO(owner): spec 9.2 shows `newDependencies: []` without an item shape; name/version/reason is assumed. */
  newDependencies: Array<{ name: string; version: string; reason: string }>;
}

export function validateTaskResult(raw: unknown): EnvelopeResult<TaskResultEnvelope> {
  const { check, root } = openEnvelope(raw, "task-result", [
    "taskId",
    "status",
    "summary",
    "changedPaths",
    "commands",
    "testFirst",
    "acceptance",
    "deviations",
    "questions",
    "newDependencies",
  ]);
  if (!root) return check.result(undefined as never);
  const commands = check.array(root, "commands", "", (item, at) => {
    const command = check.object(item, at, ["argv", "exitCode", "summary"]);
    if (!command) return undefined;
    return {
      argv: check.string(command, "argv", at) ?? "",
      exitCode: check.number(command, "exitCode", at, { integer: true }) ?? 0,
      summary: check.string(command, "summary", at, { allowEmpty: true }) ?? "",
    };
  });
  let testFirst: TaskResultEnvelope["testFirst"] = null;
  if (root.testFirst !== null && root.testFirst !== undefined) {
    const tf = check.object(root.testFirst, "/testFirst", [
      "testPath",
      "failingOutputExcerpt",
      "passingOutputExcerpt",
    ]);
    if (tf)
      testFirst = {
        testPath: check.path(tf, "testPath", "/testFirst") ?? "",
        failingOutputExcerpt: check.string(tf, "failingOutputExcerpt", "/testFirst") ?? "",
        passingOutputExcerpt:
          check.string(tf, "passingOutputExcerpt", "/testFirst", {
            allowEmpty: true,
          }) ?? "",
      };
  }
  const acceptance = check.array(root, "acceptance", "", (item, at) => {
    const entry = check.object(item, at, ["acId", "satisfiedBy"]);
    if (!entry) return undefined;
    return {
      acId: check.id(entry, "acId", at, "acceptance") ?? "",
      satisfiedBy: check.strings(entry, "satisfiedBy", at, { path: true }),
    };
  });
  const newDependencies = check.array(
    root,
    "newDependencies",
    "",
    (item, at) => {
      const dep = check.object(item, at, ["name", "version", "reason"]);
      if (!dep) return undefined;
      return {
        name: check.string(dep, "name", at, { max: 214 }) ?? "",
        version: check.string(dep, "version", at, { max: 100 }) ?? "",
        reason: check.string(dep, "reason", at) ?? "",
      };
    },
    { optional: true },
  );
  return check.result({
    schemaVersion: 1,
    kind: "task-result",
    taskId: check.id(root, "taskId", "", "task") ?? "",
    status: check.enum(root, "status", "", taskStatuses) ?? "blocked",
    summary: check.string(root, "summary", "") ?? "",
    changedPaths: check.strings(root, "changedPaths", "", { path: true }),
    commands,
    testFirst,
    acceptance,
    deviations: check.strings(root, "deviations", "", { optional: true }),
    questions: root.questions === undefined ? [] : readQuestions(check, root, "questions"),
    newDependencies,
  });
}
