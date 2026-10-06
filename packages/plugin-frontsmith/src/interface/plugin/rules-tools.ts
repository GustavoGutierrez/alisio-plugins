import type { PluginAPI, TestCaseResult, ToolDefinition, UiBlock } from "@alisio/sdk";
import type { RulesCheckResult } from "../../application/checks/rules-check.js";
import type { RulesService } from "../../application/rules/rules-service.js";
import { compileGlob } from "../../domain/glob.js";
import { isPackId } from "../../domain/ids.js";
import { ruleCategories } from "../../domain/rules/model.js";
import { isSeverity, type Severity } from "../../domain/severity.js";
import { ruleExplainMarkdown } from "../presenters/rules.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { checkInput } from "./tools.js";

const MAX_PATHS = 50;

const statusOf = (status: string): TestCaseResult["status"] =>
  status === "PASS"
    ? "passed"
    : status === "FAIL"
      ? "failed"
      : status === "REVIEW"
        ? "todo"
        : "skipped";

/** `test-results` block: suites are packs, cases are rules (spec 18.2). */
export function testResultsBlock(result: RulesCheckResult): UiBlock {
  const suites = new Map<string, TestCaseResult[]>();
  for (const check of result.checks) {
    const cases = suites.get(check.packId) ?? [];
    cases.push({
      name: check.ruleId,
      status: statusOf(check.status),
      ...(check.status === "FAIL" ||
      check.status === "REVIEW" ||
      check.status === "BLOCKED" ||
      check.status === "SKIPPED"
        ? { error: check.summary }
        : {}),
    });
    suites.set(check.packId, cases);
  }
  return {
    kind: "test-results",
    framework: "frontsmith",
    suites: [...suites].map(([name, cases]) => ({ name, cases })),
  };
}

export function validatePaths(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_PATHS ||
    !value.every((entry) => typeof entry === "string")
  )
    return `paths must be an array of at most ${MAX_PATHS} glob strings`;
  for (const entry of value as string[]) {
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.includes("\u0000") ||
      entry.split("/").includes("..")
    )
      return `paths must be relative globs without '..': ${entry}`;
    try {
      compileGlob(entry);
    } catch {
      return `invalid glob: ${entry}`;
    }
  }
  return value as string[];
}

export function rulesTools(rules: RulesService): ToolDefinition[] {
  return [
    {
      name: "fs_rules_check",
      description:
        "Run the active rule packs over the workspace. Rules that need a unit diff are skipped here and run in the build gates.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, maxItems: MAX_PATHS },
          packs: { type: "array", items: { type: "string" } },
          categories: { type: "array", items: { type: "string", enum: [...ruleCategories] } },
          minSeverity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
        },
        additionalProperties: false,
      },
      effect: "read",
      paths: (input) =>
        Array.isArray(input.paths)
          ? input.paths.filter((p): p is string => typeof p === "string")
          : [],
      async execute(input, context) {
        try {
          const problem = checkInput(input, ["paths", "packs", "categories", "minSeverity"]);
          if (problem) return errorResult(problem);
          const paths = validatePaths(input.paths);
          if (typeof paths === "string") return errorResult(paths);
          const packs = input.packs;
          if (
            packs !== undefined &&
            !(Array.isArray(packs) && packs.every((p) => typeof p === "string" && isPackId(p)))
          )
            return errorResult("packs must be pack ids");
          const categories = input.categories;
          if (
            categories !== undefined &&
            !(
              Array.isArray(categories) &&
              categories.every((c) => (ruleCategories as readonly unknown[]).includes(c))
            )
          )
            return errorResult("unknown category");
          const minSeverity = input.minSeverity;
          if (minSeverity !== undefined && !isSeverity(minSeverity))
            return errorResult("minSeverity must be blocker, major, minor or nit");
          const outcome = await rules.check(context.workspace, {
            ...(paths.length > 0 ? { paths } : {}),
            ...(packs ? { packs: packs as string[] } : {}),
            ...(categories ? { categories: categories as string[] } : {}),
            ...(minSeverity ? { minSeverity: minSeverity as Severity } : {}),
          });
          if (outcome.blocked)
            return toolResult({
              summary: `BLOCKED: the configuration or rule packs are invalid.\n${outcome.context.problems.map((p) => `- ${p}`).join("\n")}`,
              isError: true,
            });
          const { result } = outcome;
          const open = result.findings.filter((f) => f.status === "FAIL" || f.status === "REVIEW");
          const lines = open
            .slice(0, 40)
            .map(
              (f) =>
                `${f.id} ${f.ruleId} ${f.severity} ${f.status} ${f.file}:${f.line} ${f.message}`,
            );
          return toolResult({
            summary: [
              `Verdict: ${result.verdict}`,
              `${open.length} open findings, ${result.findings.length - open.length} resolved by suppression, waiver or nit`,
              ...lines,
              ...(open.length > 40 ? [`... ${open.length - 40} more`] : []),
            ].join("\n"),
            primary: testResultsBlock(result),
            secondary: [
              {
                kind: "table",
                columns: ["id", "rule", "severity", "status", "location", "message"],
                rows: result.findings.map((f) => [
                  f.id ?? "",
                  f.ruleId,
                  f.severity,
                  f.status,
                  `${f.file}:${f.line}`,
                  f.message,
                ]),
              },
            ],
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "fs_rules_list",
      description: "List the active rules, or explain one rule with its resolution trail.",
      inputSchema: {
        type: "object",
        properties: { pack: { type: "string" }, ruleId: { type: "string" } },
        additionalProperties: false,
      },
      effect: "read",
      async execute(input, context) {
        try {
          const problem = checkInput(input, ["pack", "ruleId"]);
          if (problem) return errorResult(problem);
          if (typeof input.ruleId === "string") {
            const explained = await rules.explain(context.workspace, input.ruleId);
            if (!explained.found) return errorResult(`Unknown rule ${input.ruleId}`);
            const markdown =
              explained.state === "active"
                ? ruleExplainMarkdown(explained.rule, "active", { trail: explained.rule.trail })
                : explained.state === "inactive"
                  ? ruleExplainMarkdown(explained.rule, "inactive", { reason: explained.reason })
                  : ruleExplainMarkdown(explained.rule, "disabled", { trail: explained.trail });
            return toolResult({ summary: markdown, primary: { kind: "markdown", text: markdown } });
          }
          if (input.pack !== undefined && (typeof input.pack !== "string" || !isPackId(input.pack)))
            return errorResult("pack must be a pack id");
          const { rules: list } = await rules.list(
            context.workspace,
            input.pack as string | undefined,
          );
          return toolResult({
            summary: `${list.length} active rules:\n${list.map((r) => `${r.id} ${r.severity} ${r.kind} ${r.engine} ${r.packId}`).join("\n")}`,
            primary: {
              kind: "table",
              columns: ["id", "title", "severity", "kind", "engine", "pack", "source"],
              rows: list.map((r) => [
                r.id,
                r.title,
                r.severity,
                r.kind,
                r.engine,
                r.packId,
                r.origin,
              ]),
            },
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

export function registerRulesTools(api: PluginAPI, rules: RulesService): void {
  for (const tool of rulesTools(rules)) api.tools.register(tool);
}
