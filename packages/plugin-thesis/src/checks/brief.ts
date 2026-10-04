import type { Finding } from "../types.js";
import type { LoadedProject } from "./project.js";

const hints: Record<string, string> = {
  "BRF-001": "Fix the YAML syntax, or run /thesis:init to create thesis.yaml.",
  "BRF-002": "Remove the key or correct its type; thesis.yaml uses a closed schema.",
  "BRF-003": "Use a BCP-47 tag such as es-CO, en or pt-BR.",
  "BRF-004": "Use a shipped id, or add the style under styles/ so it is discovered.",
  "BRF-005": "Add the required field to thesis.yaml.",
};

/** G0: thesis.yaml is valid and complete enough to start (BRF-*). */
export function checkBrief(project: LoadedProject): Finding[] {
  if (project.brief === undefined) {
    return [
      {
        code: "BRF-001",
        gate: "G0",
        severity: "error",
        file: "thesis.yaml",
        message: "thesis.yaml was not found",
        hint: hints["BRF-001"] as string,
      },
    ];
  }
  return project.brief.issues.map((issue) => {
    const finding: Finding = {
      code: issue.code,
      gate: "G0",
      severity: issue.severity,
      file: "thesis.yaml",
      message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
    };
    if (issue.line !== undefined) finding.line = issue.line;
    const hint = hints[issue.code];
    if (hint) finding.hint = hint;
    return finding;
  });
}
