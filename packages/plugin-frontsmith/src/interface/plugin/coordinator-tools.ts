import type { PluginAPI, ToolContext, ToolDefinition, ToolResult } from "@alisio/sdk";
import type { FrontsmithServices } from "../../application/services.js";
import {
  approvalCommand,
  parseRejectTarget,
  rejectCommand,
} from "../../application/workflow/approvals.js";
import type { JobFinishedEvent } from "../../application/workflow/coordinator.js";
import { prepareSource } from "../../application/workflow/source-spec.js";
import { isFeatureId, matchesId } from "../../domain/ids.js";
import { modes } from "../../domain/state/feature-state.js";
import { type Level, levels } from "../../domain/state/levels.js";
import { askQuestions } from "../presenters/interaction.js";
import { code } from "../presenters/markdown.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { nextMarkdown } from "../presenters/workflow.js";
import type { StatusWiring } from "./status-wiring.js";
import { checkInput } from "./tools.js";
import { chooseLevel, confirmApproval, friendly } from "./workflow.js";

const FEATURE_PATTERN = "^[a-z0-9][a-z0-9-]{0,47}$";
const MAX_TEXT = 4000;
const QUESTION_ID = "^Q-\\d{2}$";
const OPTION_LABEL_MAX = 120;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const failure = (error: unknown): ToolResult =>
  errorResult(friendly(error) ?? (error instanceof Error ? error.message : String(error)));

const nothingRecorded = (message: string, summary: string, entries: Array<[string, string]> = []) =>
  toolResult({
    summary: `${message}\n\n${summary}`,
    primary: { kind: "key-value", entries: [["recorded", "nothing"], ...entries] },
  });

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** Interactive only when a session issued the call and a UI is bound; otherwise nothing is asked. */
const canAsk = (
  api: PluginAPI,
  context: ToolContext,
): context is ToolContext & { session: string } =>
  typeof context.session === "string" && context.session !== "" && api.ui.interactive();

/** The completion notice is written by code from enums and ids only; child text never enters it. */
export function jobNotice(event: JobFinishedEvent): string {
  return `[Frontsmith] Job ${event.id} (${event.unit}) of ${event.feature} finished: ${event.outcome}. Next: ${event.next.command}`;
}

function queueNotice(api: PluginAPI, session: string | undefined, message: string): void {
  if (!session) return;
  try {
    const sessions = api.sessions as { enqueue?: (id: string, text: string) => void };
    if (typeof sessions.enqueue === "function") sessions.enqueue(session, message);
  } catch {
    // Fail-open: the completion is also in ui.status, /frontsmith:status and the dashboard.
  }
}

export function coordinatorTools(
  api: PluginAPI,
  services: FrontsmithServices,
  footer?: StatusWiring,
): ToolDefinition[] {
  const { workflow } = services;
  return [
    {
      name: "fs_feature_new",
      description:
        "Create a Frontsmith feature, optionally from a spec file (.md, .markdown or .json inside the workspace). The person picks the level in a dialog; nothing is created without it.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string", pattern: FEATURE_PATTERN },
          level: {
            type: "string",
            enum: [...levels],
            description: "Proposal only; the person picks the level in a dialog",
          },
          mode: { type: "string", enum: [...modes] },
          intent: { type: "string", minLength: 1, maxLength: MAX_TEXT },
          fromSpec: { type: "string", minLength: 1, maxLength: 1024 },
        },
        required: ["feature"],
        additionalProperties: false,
      },
      effect: "write",
      paths: (input) => (typeof input.fromSpec === "string" ? [input.fromSpec] : []),
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "level", "mode", "intent", "fromSpec"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        const proposal = text(input.level);
        if (proposal !== undefined && !(levels as readonly string[]).includes(proposal))
          return errorResult("level must be L0, L1, L2 or L3");
        const mode = text(input.mode);
        if (mode !== undefined && !(modes as readonly string[]).includes(mode))
          return errorResult(`mode must be one of ${modes.join(", ")}`);
        const intent = text(input.intent)?.trim();
        const fromSpec = text(input.fromSpec);
        if (
          input.intent !== undefined &&
          (intent === undefined || intent === "" || intent.length > MAX_TEXT)
        )
          return errorResult(`intent must be between 1 and ${MAX_TEXT} characters`);
        if (input.fromSpec !== undefined && fromSpec === undefined)
          return errorResult("fromSpec must be a path");
        if (intent === undefined && fromSpec === undefined)
          return errorResult("give an intent, a fromSpec path, or both");
        try {
          let sourceNote: string | undefined;
          if (fromSpec !== undefined) {
            const prepared = await prepareSource(
              services.deps,
              context.workspace,
              fromSpec,
              proposal,
            );
            if (!prepared.ok) return errorResult(prepared.message);
            const s = prepared.source;
            sourceNote = `Source: ${s.path} (${s.format}, ${s.bytes} bytes, sha256 ${s.sha256.slice(0, 12)})`;
          }
          const command = [
            `/frontsmith:new ${feature} --level ${proposal ?? (fromSpec ? "<L1|L2|L3>" : "<L0|L1|L2|L3>")}`,
            mode ? ` --mode ${mode}` : "",
            fromSpec ? ` --from-spec ${fromSpec}` : "",
            intent ? ` -- ${intent}` : "",
          ].join("");
          if (!canAsk(api, context))
            return nothingRecorded(
              "This session cannot ask the person, so nothing was created.",
              `Ask the person to run ${code(command)}${fromSpec && /\s/.test(fromSpec) ? " (a path with spaces needs this tool from an interactive session)" : ""}.`,
              [["command", command]],
            );
          const lines = [
            `Feature: ${feature}`,
            `Mode: ${mode ?? "build"}`,
            ...(intent ? [`Intent: ${clip(intent, 300)}`] : []),
            ...(sourceNote ? [sourceNote] : []),
          ];
          const level = await chooseLevel(
            api,
            services,
            context.workspace,
            feature,
            context.session,
            {
              withSource: fromSpec !== undefined,
              ...(proposal ? { proposal: proposal as Level } : {}),
              context: lines.join("\n"),
            },
          );
          if (level === undefined)
            return nothingRecorded(
              "No level was chosen, so nothing was created.",
              `The person can run ${code(command)} when ready.`,
              [["command", command]],
            );
          const state = await workflow.newFeature(context.workspace, {
            feature,
            level,
            ...(mode ? { mode: mode as (typeof modes)[number] } : {}),
            ...(intent ? { intent } : {}),
            ...(fromSpec !== undefined ? { fromSpec } : {}),
          });
          return toolResult({
            summary: `Created ${code(state.feature)} (${state.level}, ${state.mode}). Next: fs_next, or ${code(`/frontsmith:next ${state.feature}`)}.`,
            primary: {
              kind: "key-value",
              entries: [
                ["feature", state.feature],
                ["level", state.level],
                ["mode", state.mode],
                ["source", state.source?.path ?? "-"],
              ],
              caption: "Feature created",
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "fs_next",
      description:
        "Advance one Frontsmith unit. Stops at every human gate without running anything; units that run a child agent start as a background job and a notice arrives when they end.",
      inputSchema: {
        type: "object",
        properties: { feature: { type: "string", pattern: FEATURE_PATTERN } },
        required: ["feature"],
        additionalProperties: false,
      },
      effect: "process",
      async execute(input, context) {
        const problem = checkInput(input, ["feature"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        try {
          const outcome = await workflow.advance(context.workspace, feature, {
            sessionId: context.session ?? "",
            signal: context.signal,
            progress: (line) => {
              context.emit(line);
              void footer?.refresh(context.workspace, feature);
            },
            onJobFinished: (event) => {
              void footer?.refresh(context.workspace, feature);
              queueNotice(api, context.session, jobNotice(event));
            },
          });
          switch (outcome.kind) {
            case "waiting-for-person":
              return toolResult({
                summary: `The feature is waiting for the person; nothing was run. ${outcome.next.message} Command: ${code(outcome.next.command)}`,
                primary: {
                  kind: "progress",
                  title: `${feature}: waiting for the person`,
                  steps: [
                    { label: outcome.next.kind, status: "pending", detail: outcome.next.message },
                  ],
                },
              });
            case "job":
              return toolResult({
                summary: `Job ${outcome.id} is already running the ${outcome.unit} unit of ${feature}. Tell the person to say "continue" when the notice arrives.`,
                primary: {
                  kind: "progress",
                  title: `${feature}: ${outcome.unit}`,
                  steps: [{ label: outcome.unit, status: "running" }],
                },
              });
            case "job-started":
              return toolResult({
                summary: `Started job ${outcome.id} for the ${outcome.unit} unit of ${feature}. A notice will arrive when it ends; the person says "continue" then. Do not poll.`,
                primary: {
                  kind: "progress",
                  title: `${feature}: ${outcome.unit}`,
                  steps: [{ label: outcome.unit, status: "running", detail: `job ${outcome.id}` }],
                },
              });
            case "unit":
              return toolResult({
                summary: nextMarkdown(outcome, feature),
                primary: {
                  kind: "progress",
                  title: `${feature}: ${outcome.unit}`,
                  steps: [
                    {
                      label: outcome.unit,
                      status:
                        outcome.result.kind === "blocked" || outcome.result.kind === "cancelled"
                          ? "failed"
                          : "completed",
                      detail: outcome.result.message,
                    },
                  ],
                },
              });
          }
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "fs_answer",
      description:
        "Relay the person's answer to an open Frontsmith question. It is recorded only after the person confirms in a plugin dialog; omit answer to let the person pick an option.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string", pattern: FEATURE_PATTERN },
          questionId: { type: "string", pattern: QUESTION_ID },
          answer: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TEXT,
            description: "The person's own words, relayed verbatim",
          },
        },
        required: ["feature", "questionId"],
        additionalProperties: false,
      },
      effect: "write",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "questionId", "answer"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        const questionId = text(input.questionId);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        if (!questionId || !matchesId("question", questionId))
          return errorResult("questionId must look like Q-01");
        const relayed = input.answer === undefined ? undefined : text(input.answer)?.trim();
        if (
          input.answer !== undefined &&
          (relayed === undefined || relayed === "" || relayed.length > MAX_TEXT)
        )
          return errorResult(`answer must be between 1 and ${MAX_TEXT} characters`);
        try {
          const view = await workflow.view(context.workspace, feature);
          const { state } = await workflow.status(context.workspace, feature);
          const stored = state.questions.find((q) => q.id === questionId);
          if (!stored) return errorResult(`${feature} has no question ${questionId}.`);
          if (stored.answer !== undefined && stored.answer !== "")
            return errorResult(
              `${questionId} is already answered; changing an answer is command-only (${code(`/frontsmith:answer ${feature} ${questionId} -- <answer>`)}).`,
            );
          const open = view.openQuestions.find((q) => q.id === questionId);
          const questionText = open?.question ?? clip(stored.question, 500);
          const manual = `/frontsmith:answer ${feature} ${questionId} -- ${relayed ?? "<answer>"}`;
          if (!canAsk(api, context))
            return nothingRecorded(
              "This session cannot ask the person. Nothing was recorded.",
              `Ask the person to run ${code(manual)}.`,
              [["command", manual]],
            );
          let answer: string | undefined;
          if (relayed === undefined) {
            const options = open?.options ?? [];
            if (options.length === 0)
              return nothingRecorded(
                `${questionId} has no options to pick from.`,
                "Ask the person in chat, then call this tool again with their words in answer.",
              );
            const shown = options.slice(0, 4);
            const withOther = shown.length <= 3;
            const picked = await askQuestions(api, {
              session: context.session,
              scope: feature,
              questions: [
                {
                  id: "answer",
                  header: questionId,
                  question: questionText,
                  options: [
                    ...shown.map((option, index) => ({
                      value: `opt-${index}`,
                      label: clip(option, OPTION_LABEL_MAX),
                      ...(open?.recommendation === option ? { recommended: true } : {}),
                    })),
                    ...(withOther
                      ? [
                          {
                            value: "other",
                            label: "Other",
                            textInput: { placeholder: "Your answer" },
                          },
                        ]
                      : []),
                  ],
                },
              ],
            });
            const choice = picked?.answer;
            if (typeof choice === "string" && choice.startsWith("opt-")) {
              answer = shown[Number(choice.slice(4))];
            } else if (choice === "other") {
              const typed = picked?.["answer:text"];
              answer = typeof typed === "string" && typed.trim() !== "" ? typed.trim() : undefined;
            }
          } else {
            const confirmed = await askQuestions(api, {
              session: context.session,
              scope: feature,
              questions: [
                {
                  id: "confirm",
                  header: `Record ${questionId}`,
                  question: `Record this answer to ${questionId}?\n\n${questionText}\n\nAnswer (relayed by the assistant):\n> ${relayed.replace(/\n/g, "\n> ")}`,
                  options: [
                    {
                      value: "record",
                      label: "Record",
                      description: "Store exactly this text as your answer",
                      recommended: true,
                    },
                    { value: "no", label: "Do not record", description: "Nothing is stored" },
                  ],
                },
              ],
            });
            if (confirmed?.confirm === "record") answer = relayed;
          }
          if (answer === undefined)
            return nothingRecorded(
              "Nothing was recorded: the person did not confirm an answer.",
              `The person can answer with ${code(manual)}.`,
              [["command", manual]],
            );
          const result = await workflow.answer(context.workspace, feature, questionId, answer, {
            via: "dialog",
          });
          return toolResult({
            summary: `${result.message} Next: fs_next, or ${code(`/frontsmith:next ${feature}`)}.`,
            primary: {
              kind: "key-value",
              entries: [
                ["question", questionId],
                ["answer", clip(answer, 200)],
                ["via", "dialog"],
              ],
              caption: "Answer recorded",
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "fs_approval_request",
      description:
        "Open the approve/reject dialog for the approval a Frontsmith feature currently owes. Nothing is recorded without the person's click; config approvals are command-only.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string", pattern: FEATURE_PATTERN },
          target: {
            type: "string",
            enum: ["spec", "ui-contract", "plan", "acceptance", "review-signoff", "dependency"],
          },
          name: { type: "string", maxLength: 214 },
          comments: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TEXT,
            description: "The person's rejection comments, relayed verbatim",
          },
        },
        required: ["feature", "target"],
        additionalProperties: false,
      },
      effect: "write",
      async execute(input, context) {
        const problem = checkInput(input, ["feature", "target", "name", "comments"]);
        if (problem) return errorResult(problem);
        const feature = text(input.feature);
        const target = text(input.target);
        if (!feature || !isFeatureId(feature))
          return errorResult("feature must be a valid feature id");
        if (target === "config")
          return errorResult(
            `Re-baselining the protected files is command-only: ask the person to run ${code(approvalCommand(feature, "config"))}.`,
          );
        const allowed = [
          "spec",
          "ui-contract",
          "plan",
          "acceptance",
          "review-signoff",
          "dependency",
        ];
        if (!target || !allowed.includes(target))
          return errorResult(`target must be one of ${allowed.join(", ")}`);
        const name = text(input.name);
        const comments = input.comments === undefined ? undefined : text(input.comments)?.trim();
        if (input.comments !== undefined && (!comments || comments.length > MAX_TEXT))
          return errorResult(`comments must be between 1 and ${MAX_TEXT} characters`);
        try {
          const view = await workflow.view(context.workspace, feature);
          const approval = target as Parameters<typeof approvalCommand>[1];
          if (approval === "dependency") {
            if (!name || !view.pendingDependencies.includes(name))
              return errorResult(
                `Dependency ${name ?? "(no name)"} is not waiting for approval. Pending: ${view.pendingDependencies.join(", ") || "none"}.`,
              );
          } else if (view.owedApproval !== approval)
            return errorResult(
              view.owedApproval
                ? `${feature} owes ${view.owedApproval}, not ${approval} (${approvalCommand(feature, view.owedApproval as typeof approval)}).`
                : `Nothing is waiting for approval: ${feature} is in phase ${view.phase}. Next: ${view.next.command}`,
            );
          const approveCommand = approvalCommand(
            feature,
            approval,
            approval === "dependency" ? name : undefined,
          );
          const rejectTarget = parseRejectTarget(approval);
          const rejectManual = rejectTarget ? rejectCommand(feature, rejectTarget) : undefined;
          if (!canAsk(api, context))
            return nothingRecorded(
              "This session cannot ask the person, so nothing was recorded.",
              `Approve with ${code(approveCommand)}${rejectManual ? `, or reject with ${code(rejectManual)}` : ""}.`,
              [
                ["approve", approveCommand],
                ...(rejectManual ? [["reject", rejectManual] as [string, string]] : []),
              ],
            );
          const gate = view.gate ? `${view.gate.id} ${view.gate.verdict}` : "no gate";
          const summary = [
            `Feature ${feature} (${view.level}), phase ${view.phase}, gate ${gate}.`,
            view.artifacts.length > 0
              ? `Artifacts: ${view.artifacts.join(", ")}.`
              : "No artifacts to read yet.",
            ...(view.source
              ? [`Source: ${view.source.path} (sha256 ${view.source.sha256.slice(0, 12)}).`]
              : []),
            ...(approval === "dependency" && name ? [`Dependency: ${name}.`] : []),
          ].join("\n");
          const decision = await confirmApproval(
            api,
            context.session,
            feature,
            approval,
            summary,
            comments,
          );
          if (decision === undefined)
            return nothingRecorded(
              "The person did not decide, so nothing was recorded.",
              `Approve with ${code(approveCommand)}${rejectManual ? `, or reject with ${code(rejectManual)}` : ""}.`,
              [
                ["approve", approveCommand],
                ...(rejectManual ? [["reject", rejectManual] as [string, string]] : []),
              ],
            );
          if (decision === "details")
            return nothingRecorded(
              "The person asked to read the artifacts first; nothing was recorded.",
              `Artifacts under ${code(workflow.artifactDir(await workflow.load(context.workspace, feature, { mutating: false })))}: ${view.artifacts.join(", ") || "none"}.`,
            );
          if (decision === "reject") {
            if (!rejectTarget || !rejectManual)
              return nothingRecorded(
                `${approval} cannot be rejected here; a failed sign-off becomes a review remediation.`,
                `Nothing was recorded. Next: ${code(view.next.command)}.`,
              );
            if (!comments)
              return nothingRecorded(
                "The person chose to reject, but gave no comments yet, so nothing was recorded.",
                `Ask for the comments, then run ${code(rejectManual)} or call this tool again with comments.`,
                [["reject", rejectManual]],
              );
            const result = await workflow.reject(
              context.workspace,
              feature,
              rejectTarget,
              comments,
            );
            return toolResult({
              summary: `${result.message} Next: ${code(result.next.command)}.`,
              primary: {
                kind: "key-value",
                entries: [
                  ["decision", `rejected ${approval}`],
                  ["next", result.next.command],
                ],
                caption: "Rejection recorded",
              },
            });
          }
          const result = await workflow.approve(context.workspace, feature, approval, {
            ...(name ? { name } : {}),
            sessionId: context.session,
          });
          return toolResult({
            summary: `${result.message} Next: ${code(result.next.command)}.`,
            primary: {
              kind: "key-value",
              entries: [
                ["decision", `approved ${approval}`],
                ["next", result.next.command],
              ],
              caption: "Approval recorded",
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

export function registerCoordinatorTools(
  api: PluginAPI,
  services: FrontsmithServices,
  footer?: StatusWiring,
): void {
  for (const tool of coordinatorTools(api, services, footer)) api.tools.register(tool);
}
