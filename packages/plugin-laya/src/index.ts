/**
 * `@alisio/plugin-laya` — a local Laya decision provider.
 *
 * Registers a `DecisionProvider` (id `laya`) backed by a managed, isolated Laya server, plus the
 * `/laya:setup`, `/laya:status`, `/laya:activate` and `/laya:cancel` commands. The provider is inert until the core
 * activates it (`decisions.provider = "laya"`): no process, no network, no writes outside the
 * plugin's own directories. Laya is optional; Alisio works without it.
 */
import { definePlugin, type Plugin, type PluginAPI } from "@alisio/sdk";
import { type ActivationResult, type CommandDeps, createCommandHandlers } from "./commands.js";
import { createLayaProvider } from "./provider.js";
import { LayaRuntime, type RuntimeDeps } from "./runtime.js";
import { VERSION } from "./version.js";

export * from "./commands.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./paths.js";
export * from "./protocol/codec.js";
export * from "./provider.js";
export * from "./runtime.js";
export * from "./transport/http.js";
export { VERSION } from "./version.js";

/**
 * Optional host member (core 0.4.2+). The published SDK typings do not carry it yet, so it is
 * detected structurally and never required.
 */
interface DecisionsWithActivate {
  activate?: (providerId: string) => Promise<ActivationResult>;
}

export interface CreateLayaPluginOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
  makeSupervisor?: RuntimeDeps["makeSupervisor"];
  discover?: CommandDeps["discover"];
  install?: CommandDeps["install"];
  smoke?: CommandDeps["smoke"];
  runner?: CommandDeps["runner"];
  /** Register the synchronous last-resort kill on process exit. Default true. */
  exitHook?: boolean;
}

/**
 * Build the plugin. Everything optional in the host (`api.decisions`, `api.paths`, `api.options`)
 * is feature-detected: against an older core only the commands are registered and `/laya:status`
 * explains the version requirement.
 */
export function createLayaPlugin(options: CreateLayaPluginOptions = {}): Plugin {
  let runtime: LayaRuntime | null = null;
  const cleanups: Array<() => void> = [];

  return definePlugin({
    id: "laya",
    name: "Laya",
    description:
      "Local Laya decision provider: fast select, boolean and ordinal decisions from a managed, isolated server with consent-based setup",
    categories: ["decisions"],
    version: VERSION,
    apiVersion: 1,
    async setup(api: PluginAPI): Promise<void> {
      const env = options.env ?? process.env;
      const created = new LayaRuntime({
        env,
        ...(options.home ? { home: options.home } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
        apiPaths: api.paths,
        hostOptions: api.options,
        hostIsActive: () => api.decisions?.activeProvider()?.id === "laya",
        ...(options.makeSupervisor ? { makeSupervisor: options.makeSupervisor } : {}),
        onChange: () => {},
      });
      runtime = created;
      await created.init();

      let registered = false;
      const handlers = createCommandHandlers({
        runtime: created,
        ui: {
          interactive: () => api.ui.interactive(),
          askQuestions: (request) => api.ui.askQuestions(request),
          status: (key, text, detail) => api.ui.status(key, text, detail),
        },
        env,
        host: {
          decisions: api.decisions !== undefined,
          paths: api.paths !== undefined,
          options: api.options !== undefined,
          registered: () => registered,
          activeProviderId: () => api.decisions?.activeProvider()?.id ?? null,
          ...(typeof (api.decisions as DecisionsWithActivate | undefined)?.activate === "function"
            ? {
                activate: (id: string) =>
                  (api.decisions as DecisionsWithActivate).activate?.(id) ??
                  Promise.resolve({ status: "unavailable" as const }),
              }
            : {}),
        },
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.discover ? { discover: options.discover } : {}),
        ...(options.install ? { install: options.install } : {}),
        ...(options.smoke ? { smoke: options.smoke } : {}),
      });
      cleanups.push(
        api.commands.register("setup", (args) => handlers.setup(args), {
          description: "Install the managed Laya runtime and model (asks for consent first)",
          argumentHint:
            "[--device auto|cpu|cuda|mps] [--model multilingual|english|typed-decisions|auto] [--yes] [--repair] [--uninstall]",
        }),
        api.commands.register("status", (args) => handlers.status(args), {
          description: "Show the Laya provider, runtime and setup status",
        }),
        api.commands.register("activate", () => handlers.activate(), {
          description: "Make Laya the active decision provider (the host asks you to confirm)",
        }),
        api.commands.register("cancel", () => handlers.cancel(), {
          description: "Cancel a running Laya setup job",
        }),
      );

      if (api.decisions) {
        const provider = createLayaProvider({
          runtime: created,
          model: () => (created.config.model === "auto" ? undefined : created.config.model),
          onActivate: () => created.activate(),
          onDeactivate: () => created.deactivate(),
        });
        cleanups.push(api.decisions.registerProvider(provider));
        registered = true;
        // Hosts without activate/deactivate hooks: honor an already-active Laya.
        if (api.decisions.activeProvider()?.id === "laya") void created.activate();
      }

      if (options.exitHook !== false) {
        const onExit = () => created.killNow();
        process.once("exit", onExit);
        cleanups.push(() => process.removeListener("exit", onExit));
      }
    },
    async dispose(): Promise<void> {
      const current = runtime;
      runtime = null;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          /* best effort */
        }
      }
      if (current) await current.dispose();
    },
  });
}

export default createLayaPlugin();
