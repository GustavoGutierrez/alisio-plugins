import type { PluginAPI } from "@alisio/sdk";
import type { AgentProfile } from "../../domain/agents/roster.js";
import { ChildSessionRunner } from "../../infrastructure/sdk/child-session-runner.js";
import { ApiModelCatalog } from "../../infrastructure/sdk/model-catalog.js";
import type { Composition } from "../composition.js";
import { compose } from "../composition.js";
import { DashboardController, registerDashboard } from "../dashboard/controller.js";
import { registerArchitecture } from "./architecture.js";
import { registerRulesCommand } from "./commands.js";
import { registerFidelity } from "./fidelity.js";
import { registerModels } from "./models.js";
import { registerRulesTools } from "./rules-tools.js";
import { StatusWiring } from "./status-wiring.js";
import { registerTokens } from "./tokens.js";
import { registerDetectTools, type ToolDeps } from "./tools.js";
import { registerViews } from "./views.js";
import { registerWorkflow } from "./workflow.js";

export interface RegisterOptions {
  /** Test seam: replaces the production adapters. */
  composition?: Composition;
  deps?: Partial<ToolDeps>;
  /** Loads an agent file with its skills; the plugin entry supplies it (the root layer owns the files). */
  profiles?: (agent: string) => Promise<AgentProfile>;
  version?: string;
}

/** What the plugin entry keeps to shut the plugin down. */
export interface PluginHandle {
  dispose(): Promise<void>;
}

/** Wire every surface onto the host API (AD-12: one services facade behind all of them). */
export function registerPlugin(api: PluginAPI, options: RegisterOptions = {}): PluginHandle {
  const composition =
    options.composition ??
    compose({
      // `api.sessions` is only called when a unit runs, never in `setup()`.
      runner: new ChildSessionRunner({ sessions: api.sessions }),
      ...(options.profiles ? { profiles: options.profiles } : {}),
      ...(options.version ? { version: options.version } : {}),
      hostOptions: () => (api.options as Record<string, unknown> | undefined)?.models,
      catalog: () => new ApiModelCatalog(api),
    });
  registerDetectTools(api, { ...composition.tools, ...options.deps });
  registerRulesTools(api, composition.rules);
  registerRulesCommand(api, composition.rules);
  registerArchitecture(api, composition.architecture);
  registerTokens(api, composition.tokens);
  registerModels(api, composition.models);
  const status = new StatusWiring(api, composition.services);
  const detach = status.attach();
  registerWorkflow(api, composition.services, status);
  registerFidelity(api, composition.services);
  registerViews(api, composition.services);
  const dashboard = new DashboardController(composition.services);
  registerDashboard(api, dashboard);
  return {
    async dispose() {
      detach();
      await dashboard.dispose();
    },
  };
}
