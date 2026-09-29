import { definePlugin, type Plugin, type PluginAPI, type ToolDefinition } from "@alisio/sdk";
import { createAgileTools } from "./agile.js";
import { registerCommands } from "./commands.js";
import { type Environment, loadConfig } from "./config.js";
import { createConfluenceTools } from "./confluence.js";
import { type Clock, createClient, type Fetcher } from "./http.js";
import { createJiraTools } from "./jira.js";
import { VERSION } from "./version.js";

export * from "./agile.js";
export * from "./commands.js";
export * from "./config.js";
export * from "./confluence.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./jira.js";
export * from "./render.js";
export * from "./text.js";
export * from "./toolkit.js";
export * from "./validation.js";
export { VERSION } from "./version.js";

/** Package-local resource directories, registered relative to the built entry. */
export const resourcePaths = {
  skills: "../.agents/skills",
} as const;

/** Every tool this plugin registers. Kept explicit so tests catch drift. */
export const TOOL_NAMES = [
  "jira_get_issue",
  "jira_search",
  "jira_get_comments",
  "jira_list_projects",
  "jira_get_transitions",
  "jira_get_worklogs",
  "jira_get_versions",
  "jira_get_fields",
  "jira_get_user",
  "jira_create_issue",
  "jira_update_issue",
  "jira_add_comment",
  "jira_transition_issue",
  "jira_add_worklog",
  "jira_link_issues",
  "confluence_get_page",
  "confluence_get_page_by_url",
  "confluence_search",
  "confluence_list_spaces",
  "confluence_get_comments",
  "confluence_get_labels",
  "confluence_create_page",
  "confluence_update_page",
  "confluence_add_comment",
  "agile_list_boards",
  "agile_list_sprints",
  "agile_get_backlog",
  "agile_list_epics",
  "agile_move_issues",
] as const;

export interface CreatePluginOptions {
  /** Environment to read configuration from; defaults to `process.env`. */
  env?: Environment;
  /** Transport seam for tests and embedders; defaults to global `fetch`. */
  fetcher?: Fetcher;
  /** Clock seam used only to interpret HTTP-date Retry-After values. */
  clock?: Clock;
}

/**
 * Build the plugin. Configuration is validated during `setup`, so a host with
 * missing or partial credentials fails closed before any tool is registered.
 */
export function createAtlassianPlugin(options: CreatePluginOptions = {}): Plugin {
  return definePlugin({
    id: "atlassian",
    name: "Atlassian",
    description:
      "Read-first Jira, Confluence, and Agile tools with strict environment configuration, opt-in writes, and untrusted-content framing",
    categories: ["tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api: PluginAPI) {
      const config = loadConfig(options.env ?? process.env);
      const client = createClient(config, options.fetcher ?? fetch, options.clock);
      const tools: ToolDefinition[] = [
        ...createJiraTools(client),
        ...createConfluenceTools(client),
        ...createAgileTools(client),
      ];
      for (const tool of tools) api.tools.register(tool);
      api.resources.skills(resourcePaths.skills);
      registerCommands(api, client);
    },
  });
}

export default createAtlassianPlugin();
