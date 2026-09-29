import { definePlugin, type Plugin, type PluginAPI, type ToolDefinition } from "@alisio/sdk";
import { registerCommands } from "./commands.js";
import { type Environment, loadConfig, resolveTokenFile } from "./config.js";
import { GoogleChatClient } from "./http.js";
import { type Clock, type Sleep, systemClock, systemSleep } from "./time.js";
import { TokenStore } from "./token.js";
import { createGoogleChatTools } from "./tools.js";
import type { Fetcher } from "./transport.js";
import { VERSION } from "./version.js";

export * from "./commands.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./oauth.js";
export * from "./render.js";
export * from "./text.js";
export * from "./time.js";
export * from "./token.js";
export * from "./toolkit.js";
export * from "./tools.js";
export * from "./transport.js";
export * from "./validation.js";
export { VERSION } from "./version.js";

/** Package-local resource directories, registered relative to the built entry. */
export const resourcePaths = {
  skills: "../.agents/skills",
} as const;

/** Every tool this plugin registers. Kept explicit so tests catch drift. */
export const TOOL_NAMES = [
  "google_chat_list_spaces",
  "google_chat_list_messages",
  "google_chat_search_messages",
  "google_chat_list_memberships",
  "google_chat_send_message",
  "google_chat_edit_message",
  "google_chat_delete_message",
] as const;

/** Tools that mutate remote state and therefore declare the `write` effect. */
export const WRITE_TOOL_NAMES = [
  "google_chat_send_message",
  "google_chat_edit_message",
  "google_chat_delete_message",
] as const;

export interface CreatePluginOptions {
  /** Environment to read configuration from; defaults to `process.env`. */
  env?: Environment;
  /** Transport seam for tests and embedders; defaults to global `fetch`. */
  fetcher?: Fetcher;
  /** Clock seam used for token expiry and Retry-After dates. */
  clock?: Clock;
  /** Sleep seam used for bounded retry backoff. */
  sleep?: Sleep;
  /** Token store seam; defaults to `<configHome>/google-chat/token.json`. */
  tokenStore?: TokenStore;
}

/**
 * Build the plugin. Configuration is validated during `setup`. A partially
 * configured OAuth mode fails closed immediately; with neither mode configured
 * the plugin still loads so `google-chat:status` can explain what is missing,
 * and every capability reports an actionable error.
 */
export function createGoogleChatPlugin(options: CreatePluginOptions = {}): Plugin {
  return definePlugin({
    id: "google-chat",
    name: "Google Chat",
    description:
      "Google Chat tools with a send-only webhook mode and a full OAuth user mode, read-first defaults, and untrusted-content framing",
    categories: ["tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api: PluginAPI) {
      const env = options.env ?? process.env;
      const config = loadConfig(env);
      const tokenStore = options.tokenStore ?? new TokenStore(resolveTokenFile(env));
      const client = new GoogleChatClient(
        config,
        options.fetcher ?? fetch,
        options.clock ?? systemClock,
        options.sleep ?? systemSleep,
        tokenStore,
      );
      const tools: ToolDefinition[] = createGoogleChatTools(client);
      for (const tool of tools) api.tools.register(tool);
      api.resources.skills(resourcePaths.skills);
      registerCommands(api, client);
    },
  });
}

export default createGoogleChatPlugin();
