import type { GateReport } from "../../domain/gates/aggregate.js";
import type { Trace } from "../../domain/traceability.js";
import { bullets, document, mdTable, section } from "./md.js";

export interface ValidationInput {
  feature: string;
  specSha256: string | undefined;
  trace: readonly Trace[];
  commands: ReadonlyArray<{ name: string; argv: string; status: string; summary: string }>;
  gates: Partial<Record<string, GateReport>>;
  uiEvidence: readonly string[];
  accessibility: readonly string[];
  performance: readonly string[];
  limitations: readonly string[];
  deviations: readonly string[];
}

const resultOf = (report: GateReport | undefined): string => (report ? report.verdict : "not run");

/** `validation.md`: what was verified, how, and what was not (spec 7.2 G9, the evidence template). */
export function renderValidationMd(input: ValidationInput): string {
  const automated = ["G6", "G7", "G8"].map((id) => `${id}: ${resultOf(input.gates[id])}`);
  return document(
    `# Validation Evidence: ${input.feature}`,
    section(
      "Specification",
      bullets([input.specSha256 ? `spec.json sha256 ${input.specSha256}` : "spec not hashed"]),
    ),
    section(
      "Acceptance criteria traceability",
      mdTable(
        ["Requirement", "Criterion", "Tasks", "Tests", "Result", "Evidence"],
        input.trace.map((row) => [
          row.requirementId,
          row.acId,
          row.tasks.join(", "),
          row.tests.join(", "),
          row.status === "PASS" ? "PASS" : row.status === "MANUAL" ? "MANUAL" : "MISSING",
          row.evidence || row.note,
        ]),
      ),
    ),
    section(
      "Commands executed",
      mdTable(
        ["Command", "Argv", "Status", "Summary"],
        input.commands.map((c) => [c.name, c.argv, c.status, c.summary]),
      ),
    ),
    section("Automated results", bullets(automated)),
    section("UI evidence", bullets(input.uiEvidence)),
    section("Accessibility", bullets(input.accessibility)),
    section("Performance", bullets(input.performance)),
    section("Known limitations", bullets(input.limitations)),
    section("Deviations from specification", bullets(input.deviations, "- None")),
  );
}
