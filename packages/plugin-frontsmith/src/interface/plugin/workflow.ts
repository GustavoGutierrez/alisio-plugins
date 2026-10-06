import type { CommandContext, PluginAPI, ToolDefinition } from "@alisio/sdk";
import { FeatureLockedError } from "../../application/ports/feature-store.js";
import type { FrontsmithServices } from "../../application/services.js";
import {
  type ApprovalTarget,
  approvalCommand,
  approvalTargets,
  parseApprovalTarget,
  parseRejectTarget,
  rejectCommand,
  rejectTargets,
} from "../../application/workflow/approvals.js";
import { WorkflowError } from "../../application/workflow/coordinator.js";
import { GateCheckError } from "../../application/workflow/gate-checks.js";
import { isFeatureId } from "../../domain/ids.js";
import { type GateId, gateIds, modes } from "../../domain/state/feature-state.js";
import { type Level, levels } from "../../domain/state/levels.js";
import { askQuestions } from "../presenters/interaction.js";
import { code } from "../presenters/markdown.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import {
  budgetMarkdown,
  doctorMarkdown,
  featureListMarkdown,
  gateReportMarkdown,
  nextMarkdown,
  statusMarkdown,
} from "../presenters/workflow.js";
import { workspaceOf } from "./commands.js";
import type { StatusWiring } from "./status-wiring.js";
import { checkInput } from "./tools.js";

/** The text after the first ` -- ` is free text; everything before it is words and flags. */
export interface CommandLine {
  words: string[];
  flags: Record<string, string | true>;
  text: string;
}

const VALUE_FLAGS = ["level", "mode", "until", "task", "confirm"] as const;
const BOOLEAN_FLAGS = ["foreground"] as const;

export class UsageProblem extends Error {}

export function parseCommandLine(args: string): CommandLine {
  const marker = /(?:^|\s)--(?:\s|$)/.exec(args);
  const head = marker ? args.slice(0, marker.index) : args;
  const text = marker ? args.slice(marker.index + marker[0].length).trim() : "";
  const tokens = head.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const name = token.slice(2);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) flags[name] = true;
    else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new UsageProblem(`Option --${name} needs a value`);
      flags[name] = value;
      i += 1;
    } else throw new UsageProblem(`Unknown option --${name}`);
  }
  return { words, flags, text };
}

const usage = (line: string): string => `Usage: ${code(line)}`;

const USAGE = {
  new: "/frontsmith:new <feature> --level L0|L1|L2|L3 [--mode build|replicate|refine|redesign] -- <intent>",
  status: "/frontsmith:status [feature]",
  next: "/frontsmith:next <feature> [--foreground]",
  answer: "/frontsmith:answer <feature> <Q-id> -- <answer>",
  approve: `/frontsmith:approve <feature> ${approvalTargets.join("|")} [dependency name]`,
  reject: `/frontsmith:reject <feature> ${rejectTargets.join("|")} -- <comments>`,
  waive: "/frontsmith:waive <feature> <ruleId> <glob> --until <YYYY-MM-DD> -- <reason>",
  verify: "/frontsmith:verify-manual <feature> <AC-id> -- <evidence>",
  stop: "/frontsmith:stop <feature>",
  resume: "/frontsmith:resume <feature>",
  check: `/frontsmith:check <feature> <${gateIds.join("|")}> [--task T-001]`,
  budget: "/frontsmith:budget check|baseline",
} as const;

const featureArg = (word: string | undefined, line: string): string => {
  if (word === undefined || !isFeatureId(word)) throw new UsageProblem(usage(line));
  return word;
};

/** Errors a person can act on become their message; anything else is a bug and propagates. */
function friendly(error: unknown): string | undefined {
  if (
    error instanceof UsageProblem ||
    error instanceof WorkflowError ||
    error instanceof GateCheckError
  )
    return error.message;
  if (error instanceof FeatureLockedError) return error.message;
  return undefined;
}

const sessionOf = (context: CommandContext | undefined): string => {
  if (!context?.sessionId)
    throw new WorkflowError("No session is available to run this command from.");
  return context.sessionId;
};

async function chooseLevel(
  api: PluginAPI,
  services: FrontsmithServices,
  root: string,
  feature: string,
  sessionId: string,
): Promise<Level | undefined> {
  if (!api.ui.interactive()) return undefined;
  const config = await services.deps.project.readConfig(root);
  const preselected = config.config.defaults.level;
  const answer = await askQuestions(api, {
    session: sessionId,
    scope: feature,
    questions: [
      {
        id: "level",
        header: "Rigor level",
        question: "How much rigor does this feature need?",
        options: [
          {
            value: "L0",
            label: "L0 trivial",
            description: "A typo, copy or a local tweak: build, validate, review",
            ...(preselected === "L0" ? { recommended: true } : {}),
          },
          {
            value: "L1",
            label: "L1 small feature",
            description: "Spec approval, then a task list",
            ...(preselected === "L1" ? { recommended: true } : {}),
          },
          {
            value: "L2",
            label: "L2 product feature",
            description: "Spec, UI contract, plan and acceptance approvals",
            ...(preselected === "L2" ? { recommended: true } : {}),
          },
          {
            value: "L3",
            label: "L3 high risk",
            description: "As L2 plus decision records, two reviews and a sign-off",
            ...(preselected === "L3" ? { recommended: true } : {}),
          },
        ],
      },
    ],
  });
  const value = answer?.level;
  return typeof value === "string" && (levels as readonly string[]).includes(value)
    ? (value as Level)
    : undefined;
}

/** Interactive sessions confirm an approval with the person; headless runs get the exact command. */
async function confirmApproval(
  api: PluginAPI,
  sessionId: string,
  feature: string,
  target: ApprovalTarget,
  summary: string,
): Promise<"approve" | "reject" | "details" | undefined> {
  const answer = await askQuestions(api, {
    session: sessionId,
    scope: feature,
    questions: [
      {
        id: "decision",
        header: `Approve ${target}`,
        question: `${summary}\n\nApprove ${target} of ${feature}?`,
        options: [
          {
            value: "approve",
            label: "Approve",
            description: "Record your approval and move on",
            recommended: true,
          },
          {
            value: "reject",
            label: "Reject",
            description:
              "Go back to the producing phase (give the comments with /frontsmith:reject)",
          },
          {
            value: "details",
            label: "Show details",
            description: "Show the artifacts before deciding",
          },
        ],
      },
    ],
  });
  const value = answer?.decision;
  return value === "approve" || value === "reject" || value === "details" ? value : undefined;
}

export async function workflowCommand(
  api: PluginAPI,
  services: FrontsmithServices,
  name: string,
  args: string,
  context: CommandContext | undefined,
  footer?: StatusWiring,
): Promise<string> {
  const root = workspaceOf(api, context);
  const { workflow } = services;
  const progressOf = (feature: string) => (): void => void footer?.refresh(root, feature);
  try {
    const line = parseCommandLine(args);
    const [first, second, third] = line.words;
    switch (name) {
      case "init": {
        const result = await workflow.init(root);
        return [
          "## Frontsmith initialised",
          "",
          ...result.created.map((p) => `- created ${code(p)}`),
          ...result.existing.map((p) => `- ${code(p)} already exists (human-owned, left as it is)`),
          "",
          `Create a feature with ${code(USAGE.new)}.`,
        ].join("\n");
      }
      case "doctor":
        return doctorMarkdown(await services.doctor(root));
      case "new": {
        const feature = featureArg(first, USAGE.new);
        if (line.text === "") throw new UsageProblem(usage(USAGE.new));
        let level = line.flags.level;
        if (level !== undefined && !(levels as readonly string[]).includes(level as string))
          throw new UsageProblem(usage(USAGE.new));
        if (level === undefined) {
          level = await chooseLevel(api, services, root, feature, sessionOf(context));
          // B-17: defaults.level only preselects the interactive option; headless runs must say it.
          if (level === undefined) throw new UsageProblem(usage(USAGE.new));
        }
        const mode = line.flags.mode;
        if (mode !== undefined && !(modes as readonly string[]).includes(mode as string))
          throw new UsageProblem(usage(USAGE.new));
        const state = await workflow.newFeature(root, {
          feature,
          intent: line.text,
          level: level as Level,
          ...(typeof mode === "string" ? { mode: mode as (typeof modes)[number] } : {}),
        });
        return `Created ${code(state.feature)} (${state.level}, ${state.mode}). Run ${code(`/frontsmith:next ${state.feature}`)} to start.`;
      }
      case "status": {
        if (first === undefined) return featureListMarkdown(await workflow.list(root));
        const feature = featureArg(first, USAGE.status);
        const status = await workflow.status(root, feature);
        const config = await services.deps.project.readConfig(root);
        return statusMarkdown(status.state, status.next, {
          readOnly: status.readOnly,
          running: status.running,
          artifactDir: workflow.artifactDir(status.state, config.config.paths.artifacts),
        });
      }
      case "next": {
        const feature = featureArg(first, USAGE.next);
        const outcome = await workflow.next(root, feature, {
          sessionId: sessionOf(context),
          foreground: line.flags.foreground === true,
          progress: progressOf(feature),
        });
        return nextMarkdown(outcome, feature);
      }
      case "answer": {
        const feature = featureArg(first, USAGE.answer);
        if (second === undefined || line.text === "") throw new UsageProblem(usage(USAGE.answer));
        const result = await workflow.answer(root, feature, second, line.text);
        return `${result.message} Run ${code(`/frontsmith:next ${feature}`)}.`;
      }
      case "approve": {
        const feature = featureArg(first, USAGE.approve);
        const target = second === undefined ? undefined : parseApprovalTarget(second);
        if (!target) throw new UsageProblem(usage(USAGE.approve));
        const exact = approvalCommand(feature, target, third);
        const state = (await workflow.status(root, feature)).state;
        const decision = await confirmApproval(
          api,
          sessionOf(context),
          feature,
          target,
          `Phase ${state.phase}; read the artifacts under ${workflow.artifactDir(state)}.`,
        );
        if (decision === undefined)
          return `Approval is a human decision and this session cannot ask. Run ${code(exact)} from an interactive session.`;
        if (decision === "reject")
          return `Not approved. Give your comments with ${code(rejectCommand(feature, parseRejectTarget(target) ?? "spec"))}.`;
        if (decision === "details")
          return `Read the artifacts under ${code(workflow.artifactDir(state))}, then run ${code(exact)} again.`;
        const result = await workflow.approve(root, feature, target, {
          ...(third ? { name: third } : {}),
          sessionId: sessionOf(context),
        });
        return `${result.message} Run ${code(result.next.command)}.`;
      }
      case "reject": {
        const feature = featureArg(first, USAGE.reject);
        const target = second === undefined ? undefined : parseRejectTarget(second);
        if (!target || line.text === "") throw new UsageProblem(usage(USAGE.reject));
        const result = await workflow.reject(root, feature, target, line.text);
        return `${result.message} Run ${code(result.next.command)}.`;
      }
      case "waive": {
        const feature = featureArg(first, USAGE.waive);
        const until = line.flags.until;
        if (
          second === undefined ||
          third === undefined ||
          typeof until !== "string" ||
          line.text === ""
        )
          throw new UsageProblem(usage(USAGE.waive));
        const result = await workflow.waive(root, feature, {
          ruleId: second,
          glob: third,
          until,
          reason: line.text,
        });
        return `Recorded waiver ${code(result.id)} for ${code(second)} on ${code(third)} until ${until}.`;
      }
      case "verify-manual": {
        const feature = featureArg(first, USAGE.verify);
        if (second === undefined || line.text === "") throw new UsageProblem(usage(USAGE.verify));
        return (await workflow.verifyManual(root, feature, second, line.text)).message;
      }
      case "stop": {
        const feature = featureArg(first, USAGE.stop);
        return (await workflow.stop(root, feature))
          ? `Stopped the job of ${code(feature)}; its child sessions were cancelled.`
          : `${code(feature)} has no running job here.`;
      }
      case "resume": {
        const feature = featureArg(first, USAGE.resume);
        const result = await workflow.resume(root, feature, {
          sessionId: sessionOf(context),
          progress: progressOf(feature),
        });
        return `${result.interrupted} interrupted attempt${result.interrupted === 1 ? "" : "s"} marked.\n\n${nextMarkdown(result.outcome, feature)}`;
      }
      case "check": {
        const feature = featureArg(first, USAGE.check);
        if (second === undefined || !(gateIds as readonly string[]).includes(second))
          throw new UsageProblem(usage(USAGE.check));
        const task = line.flags.task;
        const report = await services.checkGate(root, feature, second as GateId, {
          sessionId: sessionOf(context),
          ...(typeof task === "string" ? { taskId: task } : {}),
        });
        return gateReportMarkdown(report);
      }
      case "budget": {
        if (first === "check") return budgetMarkdown(await services.budgetCheck(root));
        if (first === "baseline") {
          const result = await services.budgetBaseline(root);
          return result.ok
            ? `Recorded ${code(result.path)} (initial JS ${result.initialJsGzipBytes} B, CSS ${result.initialCssGzipBytes} B gzip).`
            : result.reason;
        }
        throw new UsageProblem(usage(USAGE.budget));
      }
      default:
        throw new UsageProblem(`Unknown command ${name}`);
    }
  } catch (error) {
    const message = friendly(error);
    if (message !== undefined) return message;
    throw error;
  }
}

const COMMANDS: Array<{ name: string; description: string; hint: string }> = [
  { name: "init", description: "Create .frontsmith/config.json and the gitignore entry", hint: "" },
  { name: "doctor", description: "Check what a Frontsmith run needs", hint: "" },
  {
    name: "new",
    description: "Create a feature",
    hint: "<feature> [--level L0-L3] [--mode build|replicate|refine|redesign] -- <intent>",
  },
  { name: "status", description: "Show a feature, or list the features", hint: "[feature]" },
  { name: "next", description: "Run the next unit of a feature", hint: "<feature> [--foreground]" },
  { name: "answer", description: "Answer an open question", hint: "<feature> <Q-id> -- <text>" },
  {
    name: "approve",
    description: "Approve a spec, contract, plan, acceptance, sign-off, config or dependency",
    hint: "<feature> spec|ui-contract|plan|acceptance|config|review-signoff|dependency <name>",
  },
  {
    name: "reject",
    description: "Reject an approval and send the comments back",
    hint: "<feature> spec|ui-contract|plan|acceptance -- <comments>",
  },
  {
    name: "waive",
    description: "Waive a rule on some paths until a date",
    hint: "<feature> <ruleId> <glob> --until <YYYY-MM-DD> -- <reason>",
  },
  {
    name: "verify-manual",
    description: "Record manual evidence for an acceptance criterion",
    hint: "<feature> <AC-id> -- <evidence>",
  },
  { name: "stop", description: "Abort the running job of a feature", hint: "<feature>" },
  { name: "resume", description: "Re-run an interrupted unit", hint: "<feature>" },
  { name: "check", description: "Run one gate ad hoc", hint: "<feature> <gate> [--task T-001]" },
  { name: "budget", description: "Check or record performance budgets", hint: "check | baseline" },
];

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export function workflowTools(
  services: FrontsmithServices,
  footer?: StatusWiring,
): ToolDefinition[] {
  return [
    {
      name: "fs_status",
      description:
        "Show the phase, gates, tasks, approvals and the next command of a Frontsmith feature, or list the features.",
      inputSchema: {
        type: "object",
        properties: { feature: { type: "string" } },
        additionalProperties: false,
      },
      effect: "read",
      async execute(input, context) {
        const problem = checkInput(input, ["feature"]);
        if (problem) return errorResult(problem);
        try {
          const feature = text(input.feature);
          if (feature === undefined) {
            const list = await services.workflow.list(context.workspace);
            return toolResult({
              summary: featureListMarkdown(list),
              primary: {
                kind: "table",
                columns: ["feature", "level", "phase"],
                rows: list.map((s) => [s.feature, s.level, s.phase]),
              },
            });
          }
          if (!isFeatureId(feature)) return errorResult("Invalid feature id");
          const status = await services.workflow.status(context.workspace, feature);
          return toolResult({
            summary: `${feature}: phase ${status.state.phase}. Next: ${status.next.command}`,
            primary: {
              kind: "progress",
              title: `${feature} (${status.state.level})`,
              steps: statusSteps(status.state),
            },
            secondary: [
              { kind: "mermaid", title: "Phase flow", source: flowSource(status.state) },
              {
                kind: "table",
                columns: ["gate", "verdict"],
                rows: Object.entries(status.state.gates).map(([id, g]) => [id, g.verdict]),
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
    {
      name: "fs_gate_run",
      description:
        "Run one Frontsmith gate on a feature as it is now and return its report (no child sessions).",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string" },
          gate: { type: "string", enum: [...gateIds] },
          taskId: { type: "string" },
        },
        required: ["feature", "gate"],
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "gate", "taskId"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        const gate = text(input.gate);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        if (!gate || !(gateIds as readonly string[]).includes(gate))
          return errorResult(`gate must be one of ${gateIds.join(", ")}`);
        const taskId = text(input.taskId);
        if (taskId !== undefined && !/^T-\d{3}$/.test(taskId))
          return errorResult("taskId must look like T-001");
        try {
          const report = await services.checkGate(context.workspace, feature, gate as GateId, {
            sessionId: context.session ?? "",
            signal: context.signal,
            progress: (l) => context.emit(l),
            ...(taskId ? { taskId } : {}),
          });
          return toolResult({
            summary: gateReportMarkdown(report),
            primary: {
              kind: "test-results",
              framework: "frontsmith",
              suites: [
                {
                  name: report.gate,
                  cases: report.checks.map((c) => ({
                    name: c.id,
                    status:
                      c.status === "PASS"
                        ? ("passed" as const)
                        : c.status === "FAIL" || c.status === "BLOCKED"
                          ? ("failed" as const)
                          : c.status === "REVIEW"
                            ? ("todo" as const)
                            : ("skipped" as const),
                    ...(c.status !== "PASS" ? { error: c.summary } : {}),
                  })),
                },
              ],
            },
            secondary: [
              {
                kind: "table",
                columns: ["id", "rule", "severity", "location", "message"],
                rows: report.findings.map((f) => [
                  f.id,
                  f.ruleId,
                  f.severity,
                  f.file ?? "-",
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
    {
      name: "fs_phase_run",
      description:
        "Run the next Frontsmith unit of a feature in the foreground, with progress, until it finishes or needs a person.",
      inputSchema: {
        type: "object",
        properties: { feature: { type: "string" }, foreground: { type: "boolean", enum: [true] } },
        required: ["feature", "foreground"],
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "foreground"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        if (input.foreground !== true)
          return errorResult("foreground must be true: this tool runs the unit in the agent loop");
        try {
          const outcome = await services.workflow.runForeground(context.workspace, feature, {
            sessionId: context.session ?? "",
            signal: context.signal,
            progress: (l) => {
              context.emit(l);
              void footer?.refresh(context.workspace, feature);
            },
          });
          return toolResult({
            summary: nextMarkdown(outcome, feature),
            primary: {
              kind: "progress",
              title: `${feature}: ${outcome.kind === "unit" ? outcome.unit : "job"}`,
              steps: [
                {
                  label: outcome.kind === "unit" ? outcome.unit : outcome.unit,
                  status:
                    outcome.kind === "unit" &&
                    (outcome.result.kind === "blocked" || outcome.result.kind === "cancelled")
                      ? "failed"
                      : "completed",
                  ...(outcome.kind === "unit" ? { detail: outcome.result.message } : {}),
                },
              ],
            },
          });
        } catch (error) {
          return errorResult(
            friendly(error) ?? (error instanceof Error ? error.message : String(error)),
          );
        }
      },
    },
    {
      name: "fs_budget_check",
      description:
        "Check the performance budgets of .frontsmith/budgets.json against the build output; optionally build first.",
      inputSchema: {
        type: "object",
        properties: { build: { type: "boolean" } },
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["build"]);
        if (problem) return errorResult(problem);
        try {
          if (input.build === true) {
            const plan = await services.buildCommand(context.workspace);
            if (!plan) return errorResult("No build command is configured or inferable.");
            const ran = await services.runBuild(context.workspace, context.signal);
            if (ran.status !== "PASS") return errorResult(`The build did not pass: ${ran.summary}`);
          }
          const result = await services.budgetCheck(context.workspace);
          return toolResult({
            summary: budgetMarkdown(result),
            primary: {
              kind: "test-results",
              framework: "frontsmith",
              suites: [
                {
                  name: "budgets",
                  cases: result.lines.map((l) => ({
                    name: l.id,
                    status:
                      l.status === "PASS"
                        ? ("passed" as const)
                        : l.status === "FAIL" || l.status === "BLOCKED"
                          ? ("failed" as const)
                          : ("skipped" as const),
                    ...(l.status !== "PASS" ? { error: l.summary } : {}),
                  })),
                },
              ],
            },
            secondary: [
              {
                kind: "table",
                columns: ["budget", "status", "summary"],
                rows: result.lines.map((l) => [l.id, l.status, l.summary]),
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

function statusSteps(state: import("../../domain/state/feature-state.js").FeatureState): Array<{
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  detail?: string;
}> {
  const order = [
    "intake",
    "context",
    "specify",
    "ui-contract",
    "tokens",
    "plan",
    "test-design",
    "build",
    "validate",
    "review",
    "accept",
    "archive",
    "closed",
  ];
  const index = order.indexOf(state.phase);
  return order
    .filter(
      (phase) =>
        phase !== "tokens" || state.artifacts.tokens !== undefined || state.phase === "tokens",
    )
    .map((phase) => {
      const at = order.indexOf(phase);
      return {
        label: phase,
        status:
          at < index || state.phase === "closed"
            ? ("completed" as const)
            : at === index
              ? state.blocked
                ? ("failed" as const)
                : ("running" as const)
              : ("pending" as const),
        ...(at === index && state.blocked ? { detail: state.blocked.reason } : {}),
      };
    });
}

function flowSource(state: import("../../domain/state/feature-state.js").FeatureState): string {
  const order = [
    "intake",
    "context",
    "specify",
    "ui-contract",
    "plan",
    "test-design",
    "build",
    "validate",
    "review",
    "accept",
    "archive",
    "closed",
  ];
  const node = (id: string): string => id.replace(/-/g, "_");
  const lines = [
    "flowchart LR",
    ...order
      .slice(0, -1)
      .map(
        (phase, i) =>
          `  ${node(phase)}[${phase}] --> ${node(order[i + 1] as string)}[${order[i + 1]}]`,
      ),
  ];
  lines.push(`  style ${node(state.phase)} fill:#fde68a,stroke:#92400e,color:#451a03`);
  return lines.join("\n");
}

export function registerWorkflow(
  api: PluginAPI,
  services: FrontsmithServices,
  footer?: StatusWiring,
): void {
  for (const command of COMMANDS)
    api.commands.register(
      command.name,
      (args, context) => workflowCommand(api, services, command.name, args, context, footer),
      {
        description: command.description,
        argumentHint: command.hint,
      },
    );
  for (const tool of workflowTools(services, footer)) api.tools.register(tool);
}
