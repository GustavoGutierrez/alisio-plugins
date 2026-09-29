/**
 * `@alisio/plugin-telemetry` — privacy-first local agent observability.
 *
 * The plugin registers five read-only query tools, four operator commands, one
 * event observer, a session-end transcript hook (only when content capture is
 * enabled) and an agent skill. The local SQLite database is always the source of
 * truth; remote OTLP export is opt-in and never blocks the agent run.
 */
import { definePlugin, type Plugin, type PluginAPI } from "@alisio/sdk";
import { registerCommands } from "./commands.js";
import {
  createTelemetryRuntime,
  type TelemetryRuntime,
  type TelemetryRuntimeOptions,
} from "./runtime.js";
import { createTelemetryTools, TOOL_NAMES } from "./tools.js";
import { VERSION } from "./version.js";

export * from "./commands.js";
export * from "./config.js";
export * from "./database.js";
export * from "./events.js";
export * from "./format.js";
export * from "./otlp.js";
export * from "./redact.js";
export * from "./runtime.js";
export * from "./store.js";
export * from "./tools.js";
export { VERSION } from "./version.js";

/** Package-local resource directories, registered relative to the built entry. */
export const resourcePaths = {
  skills: "../.agents/skills",
} as const;

export type CreateTelemetryPluginOptions = TelemetryRuntimeOptions;

/**
 * Build the plugin. Configuration is validated at setup: an invalid
 * configuration disables telemetry with an actionable message instead of
 * failing the host. The same read-only tools and commands are always registered
 * so an agent gets a stable answer rather than a missing-tool error.
 */
export function createTelemetryPlugin(options: CreateTelemetryPluginOptions = {}): Plugin {
  let runtime: TelemetryRuntime | null = null;
  return definePlugin({
    id: "telemetry",
    name: "Telemetry",
    description:
      "Privacy-first local agent observability with a SQLite source of truth, bounded read-only query tools, and opt-in OpenTelemetry-aligned OTLP export",
    categories: ["analytics"],
    version: VERSION,
    apiVersion: 1,
    setup(api: PluginAPI): void {
      const created = createTelemetryRuntime({
        ...options,
        // Production always reads through the host storage port; an explicit
        // opener (tests, embedders) still wins.
        openDatabase: options.openDatabase ?? ((path: string) => api.storage.sqlite(path)),
      });
      runtime = created;
      const tools = createTelemetryTools({
        store: created.store,
        config: created.config,
        configError: created.configError,
        now: created.now,
      });
      for (const tool of tools) api.tools.register(tool);
      api.events.on(created.handler);
      api.session.onEnd(async (info) => {
        await created.captureTranscript(info);
      });
      registerCommands(api, created);
      api.resources.skills(resourcePaths.skills);
      created.start();
    },
    async dispose(): Promise<void> {
      const current = runtime;
      runtime = null;
      if (current !== null) await current.dispose();
    },
  });
}

export { TOOL_NAMES };
export default createTelemetryPlugin();
