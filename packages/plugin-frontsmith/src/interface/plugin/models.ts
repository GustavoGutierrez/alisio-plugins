import type { CommandContext, PluginAPI, ToolDefinition } from "@alisio/sdk";
import type { ModelsService } from "../../application/models/service.js";
import { parseBindingTarget, shippedAgentTiers } from "../../domain/models/agents.js";
import { tierNames } from "../../domain/models/grammar.js";
import { ApiModelCatalog } from "../../infrastructure/sdk/model-catalog.js";
import { code } from "../presenters/markdown.js";
import {
  explainMarkdown,
  modelsMarkdown,
  modelsSummary,
  modelsTable,
} from "../presenters/models.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";
import { workspaceOf } from "./commands.js";
import { checkInput } from "./tools.js";

const USAGE = [
  "Usage:",
  `- ${code("/frontsmith:models")} shows the model of every agent and where it comes from`,
  `- ${code("/frontsmith:models check")} also validates the selectors against the connected models`,
  `- ${code("/frontsmith:models set <target> <value>")} binds ${code("tier.<reasoning|standard|fast>")} or ${code("agent.<name>")} to ${code("inherit")}, ${code("@<tier>")} (agents only) or a model`,
  `- ${code("/frontsmith:models unset <target>")} removes one runtime binding`,
  `- ${code("/frontsmith:models reset")} removes every runtime binding`,
  `- ${code("/frontsmith:models pick [target]")} chooses interactively`,
  `- ${code("/frontsmith:models explain <agent>")} prints the resolution trail`,
].join("\n");

const hostOptionsOf = (api: PluginAPI): unknown =>
  (api.options as Record<string, unknown> | undefined)?.models;

const sessionModelOf = (api: PluginAPI, sessionId: string | undefined): string | undefined => {
  if (!sessionId) return undefined;
  try {
    return api.sessions.model(sessionId);
  } catch {
    return undefined;
  }
};

export async function modelsCommand(
  api: PluginAPI,
  service: ModelsService,
  context: CommandContext | undefined,
  args: string,
): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const [sub, first, second, ...rest] = words;
  const workspace = workspaceOf(api, context);
  const hostOptions = hostOptionsOf(api);
  const sessionModel = sessionModelOf(api, context?.sessionId);
  const catalog = new ApiModelCatalog(api);
  if (sub === undefined)
    return modelsMarkdown(await service.view(workspace, { hostOptions }), sessionModel);
  switch (sub) {
    case "check":
      return first === undefined
        ? modelsMarkdown(await service.check(workspace, { hostOptions, catalog }), sessionModel)
        : USAGE;
    case "set": {
      if (first === undefined || second === undefined || rest.length > 0) return USAGE;
      const result = await service.set(workspace, first, second);
      return result.ok
        ? `Set ${first} = ${code(second)} in the runtime layer (${code(".alisio/frontsmith/models.runtime.json")}).`
        : result.message;
    }
    case "unset": {
      if (first === undefined || second !== undefined) return USAGE;
      const result = await service.unset(workspace, first);
      return result.ok ? `Removed ${first} from the runtime layer.` : result.message;
    }
    case "reset": {
      if (first !== undefined) return USAGE;
      const result = await service.reset(workspace);
      return result.removed
        ? "Removed the runtime overrides; the other layers apply again."
        : "There are no runtime overrides to remove.";
    }
    case "explain": {
      if (first === undefined || second !== undefined) return USAGE;
      const explained = await service.explain(workspace, first, { hostOptions });
      return explained
        ? explainMarkdown(explained.resolution, sessionModel)
        : `Unknown agent ${code(first)}. Use ${code("/frontsmith:models")} to list the agents.`;
    }
    case "pick": {
      if (second !== undefined) return USAGE;
      if (first !== undefined && !parseBindingTarget(first)) return USAGE;
      if (!api.ui.interactive())
        return `Choosing needs an interactive session. Run ${code("/frontsmith:models set <target> <value>")} instead.\n\n${USAGE}`;
      let target = first;
      if (!target) {
        const agents = (await service.view(workspace, { hostOptions })).rows.map(
          (row) => row.agent,
        );
        // TODO(owner): W-47 spec 18.1 wants `session` here, but `SelectRequest` (SDK 0.3.0) has no such field.
        target = await api.ui.select({
          title: "Frontsmith models: what do you want to bind?",
          options: [
            ...tierNames.map((tier) => ({
              value: `tier.${tier}`,
              label: `tier.${tier}`,
              description: "Every agent that uses this tier",
            })),
            ...agents.map((agent) => ({
              value: `agent.${agent}`,
              label: `agent.${agent}`,
              description:
                agent in shippedAgentTiers
                  ? `Default tier ${shippedAgentTiers[agent]}`
                  : "Custom agent",
            })),
          ],
        });
      }
      if (!target) return "No change.";
      const parsed = parseBindingTarget(target);
      if (!parsed) return USAGE;
      const references = await service.references(catalog);
      const value = await api.ui.select({
        title: `Frontsmith models: value for ${target}`,
        options: [
          { value: "inherit", label: "inherit", description: "Use the parent session's model" },
          ...(parsed.kind === "agent"
            ? tierNames.map((tier) => ({
                value: `@${tier}`,
                label: `@${tier}`,
                description: "Follow the tier binding",
              }))
            : []),
          ...references.map((reference) => ({ value: reference, label: reference })),
        ],
      });
      if (!value) return "No change.";
      const result = await service.set(workspace, target, value);
      return result.ok
        ? `Set ${target} = ${code(value)} in the runtime layer (${code(".alisio/frontsmith/models.runtime.json")}).`
        : result.message;
    }
    default:
      return USAGE;
  }
}

export function modelsTools(api: PluginAPI, service: ModelsService): ToolDefinition[] {
  return [
    {
      name: "fs_models",
      description:
        "Show which model each Frontsmith agent runs on, its tier and the configuration layer that decided it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      async execute(input, context) {
        try {
          const problem = checkInput(input, []);
          if (problem) return errorResult(problem);
          const view = await service.view(context.workspace, { hostOptions: hostOptionsOf(api) });
          const sessionModel = sessionModelOf(api, context.session);
          return toolResult({
            summary: modelsSummary(view, sessionModel),
            primary: modelsTable(view, sessionModel),
            ...(view.errors.length > 0 ? { isError: true } : {}),
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

export function registerModels(api: PluginAPI, service: ModelsService): void {
  for (const tool of modelsTools(api, service)) api.tools.register(tool);
  api.commands.register("models", (args, context) => modelsCommand(api, service, context, args), {
    description: "Show and change the model of each agent",
    argumentHint:
      "[check | set <target> <value> | unset <target> | reset | pick [target] | explain <agent>]",
  });
}
