import type { UiBlock } from "@alisio/sdk";
import type { CheckResult, ModelRow, ModelsView } from "../../application/models/service.js";
import { describeModelDiagnostic } from "../../domain/models/layers.js";
import type { ModelResolution } from "../../domain/models/resolve.js";
import { capOutput, code, table } from "./markdown.js";

export const MODEL_COLUMNS = [
  "agent",
  "default tier",
  "effective tier",
  "model",
  "source",
] as const;

/** `inherit (session: <model>)` when the session model is known, plain `inherit` otherwise. */
export const modelCell = (model: string | null, sessionModel: string | undefined): string =>
  model ?? (sessionModel ? `inherit (session: ${sessionModel})` : "inherit");

export const modelRow = (row: ModelRow, sessionModel: string | undefined): string[] => [
  row.agent,
  row.defaultTier,
  row.effectiveTier ?? "-",
  modelCell(row.model, sessionModel),
  row.source,
];

export function modelsTable(view: ModelsView, sessionModel: string | undefined): UiBlock {
  return {
    kind: "table",
    columns: [...MODEL_COLUMNS],
    rows: view.rows.map((row) => modelRow(row, sessionModel)),
  };
}

export function modelsMarkdown(
  view: ModelsView | CheckResult,
  sessionModel: string | undefined,
): string {
  const lines = [
    "## Frontsmith models",
    "",
    table(
      [...MODEL_COLUMNS],
      view.rows.map((row) => modelRow(row, sessionModel)),
    ),
  ];
  if (view.errors.length > 0)
    lines.push(
      "",
      "### Diagnostics",
      "",
      ...view.errors.map((d) => `- ${describeModelDiagnostic(d)}`),
    );
  if ("validated" in view && !view.validated)
    lines.push("", "Selectors were not validated against the connected models (no host catalog).");
  return capOutput(lines.join("\n"), "Run `/frontsmith:models explain <agent>` for one agent.");
}

export function explainMarkdown(
  resolution: ModelResolution,
  sessionModel: string | undefined,
): string {
  return [
    `## ${resolution.agent}`,
    "",
    `- Default tier: ${code(resolution.defaultTier)}; effective tier: ${resolution.effectiveTier ? code(resolution.effectiveTier) : "none (bound directly)"}`,
    `- Model: ${code(modelCell(resolution.model, sessionModel))} from ${code(resolution.source)}`,
    "",
    "### Resolution trail",
    "",
    ...resolution.trail.map(
      (step, index) => `${index + 1}. ${code(step.layer)}: ${code(step.key)} = ${code(step.value)}`,
    ),
  ].join("\n");
}

export function modelsSummary(view: ModelsView, sessionModel: string | undefined): string {
  const lines = view.errors.map(describeModelDiagnostic);
  lines.push(
    ...view.rows.map(
      (row) =>
        `${row.agent}: ${modelCell(row.model, sessionModel)} (tier ${row.effectiveTier ?? "-"}, ${row.source})`,
    ),
  );
  return lines.join("\n");
}
