import type {
  CheckOutcome,
  PackTestReport,
  RulesContext,
} from "../../application/rules/rules-service.js";
import type { ResolvedRule, RuleDef, TrailStep } from "../../domain/rules/model.js";
import { capOutput, code, table } from "./markdown.js";

export function rulesListMarkdown(
  rules: readonly ResolvedRule[],
  context: RulesContext,
  pack?: string,
): string {
  if (rules.length === 0)
    return pack ? `No active rules in pack ${code(pack)}.` : "No active rules.";
  const rows = rules.map((rule) => [
    rule.id,
    rule.severity,
    rule.kind,
    rule.engine,
    rule.packId,
    rule.origin,
    rule.title,
  ]);
  const inactive = pack
    ? context.resolved.inactive.filter((entry) => entry.packId === pack)
    : context.resolved.inactive;
  const lines = [
    `## Rules (${rules.length})`,
    "",
    table(["id", "severity", "kind", "engine", "pack", "source", "title"], rows),
  ];
  if (inactive.length > 0)
    lines.push(
      "",
      `${inactive.length} rule${inactive.length === 1 ? " is" : "s are"} inactive for this stack or level. Use ${code("/frontsmith:rules explain <ruleId>")} to see why.`,
    );
  return capOutput(lines.join("\n"), "Narrow the list with a pack id.");
}

const trailLines = (trail: readonly TrailStep[]): string[] =>
  trail.map((step, index) => `${index + 1}. ${code(step.source)} - ${step.change}`);

export function ruleExplainMarkdown(
  rule: RuleDef,
  state: "active" | "inactive" | "disabled",
  detail: { trail?: readonly TrailStep[]; reason?: string; origin?: string; packId?: string },
): string {
  const lines = [
    `## ${rule.id}: ${rule.title}`,
    "",
    `- State: ${state}${detail.reason ? ` (${detail.reason})` : ""}`,
    `- Severity: ${rule.severity}; kind: ${rule.kind}; category: ${rule.category}`,
    `- Engine: ${code(rule.engine)}; suppressible: ${rule.suppressible ? "yes (minor and nit only)" : "no"}`,
    `- Files: ${rule.files.map(code).join(", ")}`,
    "",
    `**Why it matters.** ${rule.rationale}`,
    "",
    `**Message.** ${rule.message}`,
    "",
    `**Fix.** ${rule.fix}`,
  ];
  if (rule.source) lines.push("", `Source: ${rule.source}`);
  if (detail.trail && detail.trail.length > 0)
    lines.push("", "### Resolution trail", "", ...trailLines(detail.trail));
  return lines.join("\n");
}

export function checkMarkdown(outcome: CheckOutcome): string {
  if (outcome.blocked)
    return [
      "## Rule check: BLOCKED",
      "",
      "The configuration or rule packs are invalid, so no rule was run.",
      "",
      ...outcome.context.problems.map((p) => `- ${p}`),
    ].join("\n");
  const { result } = outcome;
  const lines = [
    `## Rule check: ${result.verdict}`,
    "",
    `Coverage: ${result.coverage.executed}/${result.coverage.required} required checks executed, ${result.coverage.pending} pending.`,
  ];
  if (result.truncated)
    lines.push(
      "",
      "The workspace has more files than the analysis limit; the rest were not analysed.",
    );
  if (result.skippedFiles.length > 0)
    lines.push(
      "",
      `Skipped files: ${result.skippedFiles.map((f) => `${code(f.path)} (${f.reason})`).join(", ")}`,
    );
  if (result.expiredWaivers.length > 0)
    lines.push(
      "",
      `Expired waivers (ignored): ${result.expiredWaivers.map((w) => w.id).join(", ")}`,
    );
  const open = result.findings.filter((f) => f.status === "FAIL" || f.status === "REVIEW");
  if (open.length === 0) lines.push("", "No open findings.");
  else
    lines.push(
      "",
      table(
        ["id", "rule", "severity", "status", "location", "message"],
        open.map((f) => [
          f.id ?? "",
          f.ruleId,
          f.severity,
          f.status,
          `${f.file}:${f.line}`,
          f.message,
        ]),
      ),
    );
  const skipped = result.checks.filter((c) => c.status === "SKIPPED" || c.status === "BLOCKED");
  if (skipped.length > 0)
    lines.push(
      "",
      "### Not evaluated",
      "",
      table(
        ["rule", "status", "reason"],
        skipped.map((c) => [c.ruleId, c.status, c.summary]),
      ),
    );
  return capOutput(lines.join("\n"), "Run `alisio-frontsmith check --json` for the full report.");
}

export function packTestMarkdown(report: PackTestReport): string {
  const failed = report.cases.filter((c) => !c.ok);
  const lines = [
    `## Pack ${code(report.packId)}: ${failed.length === 0 ? "all fixtures behave" : `${failed.length} fixture problem${failed.length === 1 ? "" : "s"}`}`,
    "",
  ];
  if (report.cases.length > 0)
    lines.push(
      table(
        ["rule", "fixture", "expected", "result", "detail"],
        report.cases.map((c) => [c.ruleId, c.fixture, c.expected, c.ok ? "ok" : "FAIL", c.detail]),
      ),
    );
  if (report.withoutFixtures.length > 0)
    lines.push("", `Rules without fixtures: ${report.withoutFixtures.join(", ")}`);
  return lines.join("\n");
}
