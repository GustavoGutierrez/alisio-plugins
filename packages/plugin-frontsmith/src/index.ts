import { definePlugin, type PluginAPI } from "@alisio/sdk";
import {
  type PluginHandle,
  type RegisterOptions,
  registerPlugin,
} from "./interface/plugin/register.js";
import { loadAgentProfile, resourcePaths } from "./resources.js";
import { VERSION } from "./version.js";

export type { RegisterOptions } from "./interface/plugin/register.js";
export { loadAgentProfile, loadRoleInstructions, resourcePaths } from "./resources.js";

const DESCRIPTION =
  "Runs a gated frontend engineering workflow with specialist agents, deterministic rule packs, architecture, accessibility and token checks, and a reproducible visual-fidelity pipeline.";

/** Register Frontsmith on a plugin API. `options` are test seams; production passes none. */
export function registerFrontsmith(api: PluginAPI, options: RegisterOptions = {}): PluginHandle {
  // The same files are the host catalog resources and the child instructions (spec 5.2).
  api.resources.agents(resourcePaths.agents);
  api.resources.skills(resourcePaths.skills);
  return registerPlugin(api, { profiles: loadAgentProfile, version: VERSION, ...options });
}

let active: PluginHandle | undefined;

export default definePlugin({
  id: "frontsmith",
  name: "Frontsmith",
  description: DESCRIPTION,
  categories: ["methodology-harness"],
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI) {
    active = registerFrontsmith(api);
  },
  async dispose() {
    await active?.dispose();
    active = undefined;
  },
});
