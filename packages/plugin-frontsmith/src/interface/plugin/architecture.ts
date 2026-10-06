import type { CommandContext, PluginAPI, ToolDefinition } from "@alisio/sdk";
import type { ArchitectureService } from "../../application/architecture/service.js";
import { isPresetId, type PresetId, presetIds } from "../../domain/architecture/presets.js";
import {
  architectureMarkdown,
  architectureSummary,
  architectureTestResults,
  invalidArchitectureText,
  layerGraphMermaid,
  MISSING_ARCHITECTURE,
  violationsTable,
} from "../presenters/architecture.js";
import { askQuestions } from "../presenters/interaction.js";
import { code } from "../presenters/markdown.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { workspaceOf } from "./commands.js";
import { validatePaths } from "./rules-tools.js";
import { checkInput } from "./tools.js";

const USAGE = [
  "Usage:",
  `- ${code("/frontsmith:arch init [preset]")} writes .frontsmith/architecture.json (${presetIds.join(", ")})`,
  `- ${code("/frontsmith:arch check")} checks the import graph against the architecture config`,
].join("\n");

const PRESET_LABELS: Record<PresetId, { label: string; description: string }> = {
  "feature-sliced": {
    label: "Feature-Sliced Design",
    description: "app, pages, widgets, features, entities, shared with slice public APIs",
  },
  hexagonal: {
    label: "Hexagonal",
    description: "domain, application, infrastructure and ui with dependencies pointing inward",
  },
  layered: {
    label: "Layered",
    description: "pages, components, hooks, services and lib, each importing only lower layers",
  },
  atomic: {
    label: "Atomic design",
    description: "atoms, molecules, organisms, templates and pages",
  },
};

export function architectureTools(service: ArchitectureService): ToolDefinition[] {
  return [
    {
      name: "fs_architecture_check",
      description:
        "Check the workspace import graph against .frontsmith/architecture.json: direction, slices, public APIs, cycles, roles, atomic levels and unmapped files.",
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" }, maxItems: 50 } },
        additionalProperties: false,
      },
      effect: "read",
      paths: (input) =>
        Array.isArray(input.paths)
          ? input.paths.filter((p): p is string => typeof p === "string")
          : [],
      async execute(input, context) {
        try {
          const problem = checkInput(input, ["paths"]);
          if (problem) return errorResult(problem);
          const paths = validatePaths(input.paths);
          if (typeof paths === "string") return errorResult(paths);
          const outcome = await service.check(context.workspace, { paths });
          if (outcome.state === "missing") return errorResult(`BLOCKED: ${MISSING_ARCHITECTURE}`);
          if (outcome.state === "invalid") return errorResult(invalidArchitectureText(outcome));
          const { result } = outcome;
          return toolResult({
            summary: architectureSummary(result),
            primary: architectureTestResults(result),
            secondary: [
              { kind: "mermaid", source: layerGraphMermaid(result.graph), title: "Layer graph" },
              violationsTable(result),
            ],
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

export async function archCommand(
  api: PluginAPI,
  service: ArchitectureService,
  context: CommandContext | undefined,
  args: string,
): Promise<string> {
  const [sub, target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (rest.length > 0) return USAGE;
  const workspace = workspaceOf(api, context);
  if (sub === "check")
    return target === undefined ? architectureMarkdown(await service.check(workspace)) : USAGE;
  if (sub !== "init") return USAGE;
  let preset: PresetId | undefined;
  if (target !== undefined) {
    if (!isPresetId(target)) return USAGE;
    preset = target;
  } else {
    const recommended = await service.recommend(workspace);
    const answers =
      (await askQuestions(api, {
        scope: "architecture",
        session: context?.sessionId ?? "",
        questions: [
          {
            id: "preset",
            header: "Architecture",
            question: "Which architecture preset fits this project?",
            options: presetIds.map((id) => ({
              value: id,
              label: PRESET_LABELS[id].label,
              description: PRESET_LABELS[id].description,
              ...(id === recommended ? { recommended: true } : {}),
            })),
          },
        ],
      })) ?? {};
    const answer = answers.preset;
    if (typeof answer !== "string" || !isPresetId(answer))
      return `No preset was chosen. Recommended for this project: run ${code(`/frontsmith:arch init ${recommended}`)}.`;
    preset = answer;
  }
  const written = await service.init(workspace, preset);
  return written.ok
    ? `Wrote ${code(written.path)} from the ${preset} preset. Review it and commit it; run ${code("/frontsmith:arch check")} next.`
    : written.reason;
}

export function registerArchitecture(api: PluginAPI, service: ArchitectureService): void {
  for (const tool of architectureTools(service)) api.tools.register(tool);
  api.commands.register("arch", (args, context) => archCommand(api, service, context, args), {
    description: "Initialise and check the architecture configuration",
    argumentHint: "init [preset] | check",
  });
}
