import type { SpecEnvelope } from "../../domain/envelopes/spec.js";
import { bullets, document, mdTable, section } from "./md.js";

const ERROR_KINDS = new Set(["validation-error", "server-error", "offline", "forbidden"]);

/** `spec.md` with the section headings of the specification template. */
export function renderSpecMd(spec: SpecEnvelope, feature: string): string {
  return document(
    `# Feature Specification: ${feature}`,
    section("Problem", spec.problem),
    section("Objective", spec.objective),
    section(
      "Users and permissions",
      bullets(
        spec.users.map(
          (u) => `**${u.role}**: ${u.permissions.join(", ") || "no permissions listed"}`,
        ),
      ),
    ),
    section("In scope", bullets(spec.inScope)),
    section("Out of scope", bullets(spec.outOfScope)),
    section(
      "Functional requirements",
      mdTable(
        ["ID", "Priority", "Requirement"],
        spec.requirements.map((r) => [r.id, r.priority, r.statement]),
      ),
    ),
    section("Business rules", bullets(spec.businessRules)),
    section(
      "User-visible states",
      mdTable(
        ["ID", "Kind", "Description"],
        spec.states.map((s) => [s.id, s.kind, s.description]),
      ),
    ),
    section(
      "Error handling",
      bullets(
        spec.states.filter((s) => ERROR_KINDS.has(s.kind)).map((s) => `${s.id}: ${s.description}`),
      ),
    ),
    section(
      "Acceptance criteria",
      mdTable(
        ["ID", "Requirement", "Given", "When", "Then", "Critical"],
        spec.acceptanceCriteria.map((ac) => [
          ac.id,
          ac.requirementId,
          ac.given,
          ac.when,
          ac.then,
          ac.critical ? "yes" : "no",
        ]),
      ),
    ),
    section("Edge cases", bullets(spec.edgeCases)),
    section("Analytics / telemetry", bullets(spec.analytics)),
    section("Accessibility requirements", bullets(spec.accessibility)),
    section("Performance requirements", bullets(spec.performance)),
    section("Security / privacy considerations", bullets(spec.security)),
    section("Assumptions", bullets(spec.assumptions)),
    section(
      "Open questions",
      bullets(
        spec.openQuestions.map(
          (q) =>
            `${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}${q.options.length > 0 ? ` Options: ${q.options.join("; ")}.` : ""}${q.recommendation ? ` Recommended: ${q.recommendation}.` : ""}`,
        ),
      ),
    ),
  );
}
