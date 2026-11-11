/**
 * `@alisio/plugin-bekko` — a local "System One" decision provider.
 *
 * Registers the `bekko` `DecisionProvider` and the `/bekko:status`, `/bekko:setup` and
 * `/bekko:activate` commands. Installing or loading the plugin downloads nothing: the pinned model
 * is fetched once when the provider is activated or `/bekko:setup` runs, then runs on the CPU.
 */
import { definePlugin, type Plugin, type PluginAPI } from "@alisio/sdk";
import { defaultCacheDir } from "./cache.js";
import { createEngineFactory } from "./engine.js";
import { formatBytes, isVariant, VARIANTS } from "./pins.js";
import { createBekkoProvider, PROVIDER_ID } from "./provider.js";
import { BekkoRuntime } from "./runtime.js";
import type { EngineFactory, Variant } from "./types.js";
import { VERSION } from "./version.js";

export { createCachedFetch, defaultCacheDir, isAllowedHost } from "./cache.js";
export { BekkoRequestError, BekkoResponseError, decode, type Encoded, encode } from "./codec.js";
export { createEngineFactory } from "./engine.js";
export { type PinnedFile, VARIANTS, type VariantPin } from "./pins.js";
export { createBekkoProvider, PROVIDER_ID, toProviderError } from "./provider.js";
export { BekkoRuntime, type RuntimeSnapshot, type RuntimeState } from "./runtime.js";
export type * from "./types.js";
export { VERSION } from "./version.js";

export interface BekkoOptions {
  /** `68m` (default, about 200 MB) or `17m` (about 33 MB, lower quality). */
  variant?: Variant;
  /** Replaces the model loader (tests, custom runtimes). */
  engineFactory?: EngineFactory;
  /** Overrides the model cache directory. */
  cacheDir?: string;
}

function activationMessage(status: string, message?: string): string {
  switch (status) {
    case "activated":
      return "Bekko is now the active decision provider. The model loads in the background; follow it with /bekko:status.";
    case "already_active":
      return "Bekko is already the active decision provider.";
    case "other_provider_active":
      return "Another decision provider is configured; Bekko did not replace it. Change decisions.provider to switch.";
    case "declined":
      return "Activation declined; nothing changed.";
    case "needs_confirmation":
      return 'Activation needs your confirmation, which could not be asked here. Run /bekko:activate from an interactive session, or set decisions.provider = "bekko" in the global Alisio configuration.';
    case "disabled":
      return "Decisions are disabled in the Alisio configuration (decisions.enabled = false).";
    default:
      return `Bekko could not be activated${message ? `: ${message.slice(0, 200)}` : "."}`;
  }
}

export function createBekkoPlugin(options: BekkoOptions = {}): Plugin {
  const variant: Variant = isVariant(options.variant) ? options.variant : "68m";
  let runtime: BekkoRuntime | null = null;
  const cleanups: Array<() => void> = [];

  return definePlugin({
    id: PROVIDER_ID,
    name: "Bekko",
    version: VERSION,
    apiVersion: 1,
    description:
      "Local Bekko System One decision provider: fast select, boolean and ordinal decisions from a small on-device model",
    categories: ["decisions"],
    async setup(api: PluginAPI): Promise<void> {
      const factory =
        options.engineFactory ??
        createEngineFactory(options.cacheDir ?? defaultCacheDir(api.paths?.cache));
      const created = new BekkoRuntime(variant, factory);
      runtime = created;
      const pin = VARIANTS[variant];

      cleanups.push(
        api.commands.register(
          "status",
          async () => {
            const { state, detail } = created.snapshot();
            const active = api.decisions?.activeProvider()?.id ?? "none";
            const lines = [
              `Bekko ${variant}: ${state}${detail ? ` (${detail})` : ""}`,
              `Active decision provider: ${active}`,
            ];
            if (!api.decisions) lines.push("This Alisio version has no decisions API.");
            return lines.join("\n");
          },
          { description: "Show the Bekko model state and the active decision provider" },
        ),
      );
      cleanups.push(
        api.commands.register(
          "setup",
          async () => {
            created.activate();
            return [
              `Preparing Bekko ${variant}. The first run downloads about ${formatBytes(pin.bytes)} from Hugging Face (${pin.model}, pinned revision) and verifies every file; later runs use the local copy.`,
              "Follow progress with /bekko:status. This does not change the active decision provider; use /bekko:activate for that.",
            ].join("\n");
          },
          { description: "Download and load the Bekko model now (network on first run)" },
        ),
      );
      cleanups.push(
        api.commands.register(
          "activate",
          async () => {
            if (!api.decisions?.activate) {
              return 'This Alisio version cannot activate providers from a plugin. Set decisions.provider = "bekko" in the global Alisio configuration.';
            }
            const result = await api.decisions.activate(PROVIDER_ID, { recommend: true });
            return activationMessage(result.status, result.message);
          },
          { description: "Ask Alisio to make Bekko the active decision provider" },
        ),
      );

      if (api.decisions) {
        cleanups.push(api.decisions.registerProvider(createBekkoProvider(created)));
      }
    },
    async dispose(): Promise<void> {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort
        }
      }
      await runtime?.dispose();
      runtime = null;
    },
  });
}

export default createBekkoPlugin();
