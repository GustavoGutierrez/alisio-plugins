import type { TestCaseResult, UiBlock } from "@alisio/sdk";
import type { ArchitectureOutcome } from "../../application/architecture/service.js";
import {
  type ArchitectureCheckResult,
  architectureChecks,
  architectureRules,
} from "../../application/checks/architecture-check.js";
import { capOutput, code, table } from "./markdown.js";

/** Mermaid flowchart of the layers; edges with a direction violation are dotted. */
export function layerGraphMermaid(graph: ArchitectureCheckResult["graph"]): string {
  const id = (name: string): string => `L_${name.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const lines = ["flowchart LR", ...graph.layers.map((layer) => `  ${id(layer)}["${layer}"]`)];
  for (const edge of graph.edges)
    lines.push(
      `  ${id(edge.from)} ${edge.violating ? "-.->" : "-->"}|${edge.count}| ${id(edge.to)}`,
    );
  return lines.join("\n");
}

export function architectureTestResults(result: ArchitectureCheckResult): UiBlock {
  const cases: TestCaseResult[] = architectureChecks.map((check) => {
    const count = result.byCheck[check];
    const rule = architectureRules[check];
    return {
      name: `${rule.ruleId} ${check}`,
      status: count === 0 ? "passed" : rule.severity === "minor" ? "todo" : "failed",
      ...(count > 0 ? { error: `${count} violation${count === 1 ? "" : "s"}` } : {}),
    };
  });
  return {
    kind: "test-results",
    framework: "frontsmith",
    suites: [{ name: "architecture", cases }],
  };
}

export function violationsTable(result: ArchitectureCheckResult): UiBlock {
  return {
    kind: "table",
    columns: ["rule", "severity", "location", "detail"],
    rows: result.violations.map((v) => [v.ruleId, v.severity, `${v.file}:${v.line}`, v.detail]),
  };
}

export function architectureSummary(result: ArchitectureCheckResult): string {
  const lines = [
    `Verdict: ${result.verdict}`,
    `${result.violations.length} violation${result.violations.length === 1 ? "" : "s"} over ${result.filesChecked} source files`,
    ...result.violations
      .slice(0, 40)
      .map((v) => `${v.ruleId} ${v.severity} ${v.file}:${v.line} ${v.detail}`),
  ];
  if (result.violations.length > 40) lines.push(`... ${result.violations.length - 40} more`);
  if (result.truncated)
    lines.push("The workspace exceeds the analysis limit; some files were not analysed.");
  return lines.join("\n");
}

export const MISSING_ARCHITECTURE =
  "No .frontsmith/architecture.json. Run /frontsmith:arch init to choose a preset.";

export function invalidArchitectureText(
  outcome: Extract<ArchitectureOutcome, { state: "invalid" }>,
): string {
  return [
    "BLOCKED: .frontsmith/architecture.json is invalid.",
    ...outcome.errors.map((e) => `- ${e.pointer || "/"}: ${e.message}`),
  ].join("\n");
}

export function architectureMarkdown(outcome: ArchitectureOutcome): string {
  if (outcome.state === "missing")
    return `## Architecture check: BLOCKED\n\n${MISSING_ARCHITECTURE}`;
  if (outcome.state === "invalid")
    return `## Architecture check: BLOCKED\n\n${invalidArchitectureText(outcome)}`;
  const { result } = outcome;
  const lines = [
    `## Architecture check: ${result.verdict}`,
    "",
    `${result.violations.length} violation${result.violations.length === 1 ? "" : "s"} over ${result.filesChecked} source files.`,
    "",
    "```mermaid",
    layerGraphMermaid(result.graph),
    "```",
  ];
  if (result.violations.length > 0)
    lines.push(
      "",
      table(
        ["rule", "severity", "location", "detail"],
        result.violations.map((v) => [v.ruleId, v.severity, code(`${v.file}:${v.line}`), v.detail]),
      ),
    );
  return capOutput(lines.join("\n"), "Run `alisio-frontsmith arch --json` for the full report.");
}
