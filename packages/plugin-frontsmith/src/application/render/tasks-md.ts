import type { PlanTask } from "../../domain/envelopes/plan.js";
import { bullets, document } from "./md.js";

/** `tasks.md`: one execution contract per task, with the headings of the task template. */
export function renderTasksMd(tasks: readonly PlanTask[], feature: string): string {
  const blocks = tasks.map((task) =>
    [
      `## ${task.id}: ${task.title}`,
      `Layer: ${task.layer}. Test first: ${task.tdd}${task.tddExemptReason ? ` (${task.tddExemptReason})` : ""}.`,
      "### Goal",
      task.goal,
      "### Scope",
      bullets(task.files.map((f) => `Files: ${f}`)),
      "### Requirements",
      bullets(task.acceptanceCriteria),
      "### Tests to add or update",
      bullets(task.tests.map((t) => `${t.path} (${t.level})`)),
      "### Validation commands",
      bullets(task.validation),
      "### Constraints",
      bullets(task.constraints),
      "### Dependencies",
      bullets(task.dependsOn),
      "### Stop conditions",
      bullets(task.stopConditions),
    ].join("\n\n"),
  );
  return document(`# Tasks: ${feature}`, ...blocks);
}
