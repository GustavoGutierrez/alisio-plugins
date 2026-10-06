import type { CommandContext, PluginAPI, ToolDefinition } from "@alisio/sdk";
import type { FrontsmithServices } from "../../application/services.js";
import { WorkflowError } from "../../application/workflow/coordinator.js";
import { isFeatureId } from "../../domain/ids.js";
import {
  a11yBlock,
  a11yMarkdown,
  baselinesMarkdown,
  calibrationMarkdown,
  fidelityBlock,
  fidelityMarkdown,
  fidelityTable,
} from "../presenters/fidelity.js";
import { askQuestions } from "../presenters/interaction.js";
import { code } from "../presenters/markdown.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { workspaceOf } from "./commands.js";
import { checkInput } from "./tools.js";
import { parseCommandLine, UsageProblem } from "./workflow.js";

const USAGE = {
  fidelity:
    "/frontsmith:fidelity run <feature> [case,case] | calibrate <feature> [--confirm CALIBRATE]",
  baseline: "/frontsmith:baseline approve <feature> [caseId] | list <feature>",
} as const;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const CASE_ID = /^[a-z][a-z0-9-]{1,47}$/;

function casesFrom(word: string | undefined): string[] | undefined {
  if (word === undefined) return undefined;
  const ids = word.split(",").filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => CASE_ID.test(id)))
    throw new UsageProblem(`Usage: ${code(USAGE.fidelity)}`);
  return ids;
}

async function contractOf(
  services: FrontsmithServices,
  root: string,
  feature: string,
): Promise<string> {
  const found = await services.fidelity.contractPathOf(root, feature);
  if (!found.ok) throw new WorkflowError(found.reason);
  return found.path;
}

function friendly(error: unknown): string | undefined {
  return error instanceof UsageProblem || error instanceof WorkflowError
    ? error.message
    : undefined;
}

export async function fidelityCommand(
  api: PluginAPI,
  services: FrontsmithServices,
  name: "fidelity" | "baseline",
  args: string,
  context: CommandContext | undefined,
): Promise<string> {
  const root = workspaceOf(api, context);
  try {
    const line = parseCommandLine(args);
    const [sub, featureWord, third] = line.words;
    const feature = featureWord ?? "";
    if (!isFeatureId(feature)) throw new UsageProblem(`Usage: ${code(USAGE[name])}`);
    if (name === "baseline") {
      if (sub === "list")
        return baselinesMarkdown(feature, await services.fidelity.listBaselines(root, feature));
      if (sub !== "approve") throw new UsageProblem(`Usage: ${code(USAGE.baseline)}`);
      if (third !== undefined && !CASE_ID.test(third))
        throw new UsageProblem(`Usage: ${code(USAGE.baseline)}`);
      const result = await services.fidelity.approveBaseline(root, feature, third);
      return result.ok
        ? `Approved baseline${result.approved.length === 1 ? "" : "s"}: ${result.approved.map(code).join(", ")}. Calibrate with ${code(`/frontsmith:fidelity calibrate ${feature}`)}.`
        : result.reason;
    }
    const contractPath = await contractOf(services, root, feature);
    const runId = services.deps.newId();
    if (sub === "run") {
      const cases = casesFrom(third);
      const run = await services.fidelity.runDetailed({
        root,
        feature,
        contractPath,
        runId,
        ...(cases ? { cases } : {}),
      });
      return fidelityMarkdown(run.report, run.composite?.path);
    }
    if (sub === "calibrate") {
      const flag = line.flags.confirm;
      if (flag !== undefined && flag !== "CALIBRATE")
        throw new UsageProblem(`Usage: ${code(USAGE.fidelity)}`);
      const plan = await services.fidelity.calibrate(root, feature, {
        contractPath,
        runId,
        confirm: false,
      });
      if (!plan.ok) return plan.reason;
      const confirmCommand = `/frontsmith:fidelity calibrate ${feature} --confirm CALIBRATE`;
      let confirmed = flag === "CALIBRATE";
      if (!confirmed) {
        const answer = await askQuestions(api, {
          session: context?.sessionId ?? "",
          scope: feature,
          questions: [
            {
              id: "calibrate",
              header: "Calibration",
              question: `Write calibration ${plan.file.id}? It becomes a protected oracle for the visual checks${plan.unseparable.length > 0 ? ` (${plan.unseparable.length} region(s) are unseparable and stay REVIEW)` : ""}.`,
              options: [
                {
                  value: "write",
                  label: "Write it",
                  description: "Save .frontsmith/calibration and protect it",
                  recommended: true,
                },
                {
                  value: "cancel",
                  label: "Do not write",
                  description: "Keep the files as they are",
                },
              ],
            },
          ],
        });
        confirmed = answer?.calibrate === "write";
      }
      if (confirmed) await services.fidelity.saveCalibration(root, feature, plan.file);
      return calibrationMarkdown(
        plan.file,
        plan.quality,
        plan.unseparable,
        confirmed,
        confirmCommand,
      );
    }
    throw new UsageProblem(`Usage: ${code(USAGE.fidelity)}`);
  } catch (error) {
    const message = friendly(error);
    if (message !== undefined) return message;
    throw error;
  }
}

export function fidelityTools(services: FrontsmithServices): ToolDefinition[] {
  return [
    {
      name: "fs_fidelity_run",
      description:
        "Run the visual-fidelity pipeline for a feature: measure the contract's elements in the real browser, compare regions with the approved baselines and return the composite evidence image.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string" },
          cases: { type: "array", items: { type: "string" }, maxItems: 50 },
          stage: { type: "string", enum: ["measure", "full"] },
          calibrate: { type: "boolean" },
        },
        required: ["feature"],
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "cases", "stage", "calibrate"]);
        if (problem) return errorResult(problem);
        const feature = typeof input.feature === "string" ? input.feature : "";
        if (!isFeatureId(feature)) return errorResult("feature must be a valid feature id");
        const cases = input.cases;
        if (
          cases !== undefined &&
          (!Array.isArray(cases) || !cases.every((c) => typeof c === "string" && CASE_ID.test(c)))
        )
          return errorResult("cases must be case ids");
        if (input.stage !== undefined && input.stage !== "measure" && input.stage !== "full")
          return errorResult("stage must be measure or full");
        try {
          const found = await services.fidelity.contractPathOf(context.workspace, feature);
          if (!found.ok) return errorResult(found.reason);
          const runId = services.deps.newId();
          if (input.calibrate === true) {
            // The tool never writes a calibration: that is a human decision (spec 11.4).
            const plan = await services.fidelity.calibrate(context.workspace, feature, {
              contractPath: found.path,
              runId,
              confirm: false,
              signal: context.signal,
            });
            if (!plan.ok) return errorResult(plan.reason);
            return toolResult({
              summary: calibrationMarkdown(
                plan.file,
                plan.quality,
                plan.unseparable,
                false,
                `/frontsmith:fidelity calibrate ${feature} --confirm CALIBRATE`,
              ),
              primary: {
                kind: "json",
                value: { id: plan.file.id, unseparable: plan.unseparable, quality: plan.quality },
                collapsedDepth: 2,
              },
            });
          }
          const run = await services.fidelity.runDetailed({
            root: context.workspace,
            feature,
            contractPath: found.path,
            runId,
            signal: context.signal,
            ...(cases ? { cases: cases as string[] } : {}),
            ...(typeof input.stage === "string"
              ? { stage: input.stage as "measure" | "full" }
              : {}),
          });
          return toolResult({
            summary: fidelityMarkdown(run.report, run.composite?.path),
            primary: fidelityBlock(run.report),
            ...(run.composite
              ? { image: { mimeType: "image/png", data: base64(run.composite.bytes) } }
              : {}),
            secondary: [fidelityTable(run.report)],
            moreImages: run.crops.map((c) => ({ mimeType: "image/png", data: base64(c.bytes) })),
          });
        } catch (error) {
          return errorResult(
            friendly(error) ?? (error instanceof Error ? error.message : String(error)),
          );
        }
      },
    },
    {
      name: "fs_a11y_run",
      description:
        "Run the runtime accessibility checks of a feature: axe violations, the keyboard focus order and the contrast of the painted colours. Automated checks do not establish WCAG conformance.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string" },
          cases: { type: "array", items: { type: "string" }, maxItems: 50 },
        },
        required: ["feature"],
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "cases"]);
        if (problem) return errorResult(problem);
        const feature = typeof input.feature === "string" ? input.feature : "";
        if (!isFeatureId(feature)) return errorResult("feature must be a valid feature id");
        const cases = input.cases;
        if (
          cases !== undefined &&
          (!Array.isArray(cases) || !cases.every((c) => typeof c === "string" && CASE_ID.test(c)))
        )
          return errorResult("cases must be case ids");
        try {
          const found = await services.fidelity.contractPathOf(context.workspace, feature);
          if (!found.ok) return errorResult(found.reason);
          const run = await services.fidelity.a11yDetailed({
            root: context.workspace,
            feature,
            contractPath: found.path,
            runId: `${services.deps.newId()}-a11y`,
            signal: context.signal,
            ...(cases ? { cases: cases as string[] } : {}),
          });
          return toolResult({
            summary: a11yMarkdown(run.report),
            primary: a11yBlock(run.report),
            secondary: [
              {
                kind: "table",
                columns: ["rule", "case", "element", "severity", "status", "message"],
                rows: run.report.findings.map((f) => [
                  f.ruleId,
                  f.caseId,
                  f.elementId ?? "-",
                  f.severity,
                  f.status,
                  f.message,
                ]),
              },
            ],
          });
        } catch (error) {
          return errorResult(
            friendly(error) ?? (error instanceof Error ? error.message : String(error)),
          );
        }
      },
    },
  ];
}

export function registerFidelity(api: PluginAPI, services: FrontsmithServices): void {
  api.commands.register(
    "fidelity",
    (args, context) => fidelityCommand(api, services, "fidelity", args, context),
    {
      description: "Run or calibrate the visual-fidelity pipeline",
      argumentHint: "run <feature> [cases] | calibrate <feature> [--confirm CALIBRATE]",
    },
  );
  api.commands.register(
    "baseline",
    (args, context) => fidelityCommand(api, services, "baseline", args, context),
    {
      description: "Approve or list the visual baselines of a feature",
      argumentHint: "approve <feature> [caseId] | list <feature>",
    },
  );
  for (const tool of fidelityTools(services)) api.tools.register(tool);
}
