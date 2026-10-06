import type { PlanEnvelope } from "../../domain/envelopes/plan.js";
import { bullets, document, mdTable, section } from "./md.js";

/** `plan.md`: components, state, contracts, errors, dependencies, risks and the task order. */
export function renderPlanMd(plan: PlanEnvelope, feature: string): string {
  return document(
    `# Technical Plan: ${feature}`,
    section("Summary", plan.summary),
    section(
      "Components",
      mdTable(
        ["Name", "Path", "Action", "Level", "Role", "Patterns"],
        plan.components.map((c) => [
          c.name,
          c.path,
          c.action,
          c.atomicLevel,
          c.role,
          c.patterns.join(", "),
        ]),
      ),
    ),
    section(
      "State ownership",
      mdTable(
        ["State", "Owner", "Tool", "Location"],
        plan.state.map((s) => [s.name, s.owner, s.tool, s.location]),
      ),
    ),
    section("Data flow", bullets(plan.dataFlow)),
    section(
      "Contracts",
      mdTable(
        ["Kind", "File", "Operations"],
        plan.contracts.map((c) => [c.kind, c.file, c.operations.join(", ")]),
      ),
    ),
    section(
      "Error handling",
      bullets(plan.errors.map((e) => `${e.operation}: ${e.cases.join("; ")}`)),
    ),
    section(
      "New dependencies",
      mdTable(
        ["Name", "Version", "Reason"],
        plan.dependencies.map((d) => [d.name, d.version, d.reason]),
      ),
    ),
    section("Decision records", bullets(plan.adrs.map((a) => `${a.id}: ${a.title}`))),
    section(
      "Risks",
      mdTable(
        ["Category", "Risk"],
        plan.risks.map((r) => [r.category, r.text]),
      ),
    ),
    section(
      "Task order",
      mdTable(
        ["Task", "Layer", "Title", "Depends on", "Test first"],
        plan.tasks.map((t) => [t.id, t.layer, t.title, t.dependsOn.join(", "), t.tdd]),
      ),
    ),
  );
}
