import { definePlugin, type Plugin, type PluginAPI } from "@alisio/sdk";
import { registerCommands } from "./commands.js";
import { type Environment, KeyStore, resolveKeyFile } from "./config.js";
import type { Fetcher } from "./http.js";
import { createTools } from "./tools.js";
import { VERSION } from "./version.js";

export * from "./commands.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./render.js";
export * from "./tools.js";
export * from "./validation.js";
export { VERSION } from "./version.js";

/** Package-local resource directories, registered relative to the built entry. */
export const resourcePaths = {
  skills: "../.agents/skills",
} as const;

export interface CreatePluginOptions {
  /** Environment to read the key from; defaults to `process.env`. */
  env?: Environment;
  /** Transport seam for tests and embedders; defaults to global `fetch`. */
  fetcher?: Fetcher;
  /** Key file seam; defaults to `<configHome>/brave-search/api-key`. */
  keyStore?: KeyStore;
}

/**
 * Build the plugin. It always loads, even without a key, so that
 * `/brave-search:status` and `/brave-search:set-key` can guide setup; tools
 * then fail with an actionable message and make no network call.
 */
export function createBraveSearchPlugin(options: CreatePluginOptions = {}): Plugin {
  return definePlugin({
    id: "brave-search",
    name: "Brave Search",
    description:
      "Brave Search for coding agents: LLM Context grounding with pre-extracted page content under a token budget, plus a compact web search fallback",
    categories: ["search", "tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api: PluginAPI) {
      const env = options.env ?? process.env;
      const keyStore = options.keyStore ?? new KeyStore(resolveKeyFile(env));
      const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
      for (const tool of createTools({ fetcher, env, keyStore })) api.tools.register(tool);
      api.resources.skills(resourcePaths.skills);
      registerCommands(api, { env, keyStore });
    },
  });
}

export default createBraveSearchPlugin();
