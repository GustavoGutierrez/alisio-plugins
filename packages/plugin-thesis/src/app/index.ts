import { readFile } from "node:fs/promises";
import type { PluginAPI, PluginAppAction } from "@alisio/sdk";
import type { CoordinatorOptions, ThesisCoordinator } from "../coordinator.js";
import type { WorkspaceLock } from "../lock.js";
import { ALL_ACTIONS, effectOf, SCHEMAS, type StudioAction } from "./actions.js";
import { type StudioError, studioErrorOf } from "./jobs.js";
import { StudioService } from "./service.js";

export type { PluginAppAction, PluginAppContext, PluginAppDefinition } from "@alisio/sdk";

/** Extra fields an error result may carry; everything else is dropped (§8). */
const SAFE_EXTRA: Record<string, readonly string[]> = {
  busy: ["holder", "label"],
  blocked: ["reason"],
  invalid_input: ["fields", "line", "column"],
  too_large: ["path"],
};

/** `{ error: code, ...safe extra }` for one failed action: never a message, input or stack. */
export function errorResult(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  const failure: StudioError = studioErrorOf(error, signal);
  const extra: Record<string, unknown> = {};
  for (const key of SAFE_EXTRA[failure.code] ?? [])
    if (failure.extra[key] !== undefined) extra[key] = failure.extra[key];
  return { error: failure.code, ...extra };
}

export function buildActions(service: StudioService): Record<string, PluginAppAction> {
  const actions: Record<string, PluginAppAction> = {};
  for (const action of ALL_ACTIONS)
    actions[action] = {
      effect: effectOf(action),
      inputSchema: SCHEMAS[action],
      async handler(input, context) {
        context.signal.throwIfAborted();
        try {
          // Workspace and session come from the context, never from the input.
          return { value: await service.invoke(action as StudioAction, input, context) };
        } catch (error) {
          return errorResult(error, context.signal);
        }
      },
    };
  return actions;
}

/**
 * Registers Thesis Studio on a host with `api.apps` (D1). Per activation: the service, its jobs
 * and idempotency records live here and are released by this app's `dispose` only.
 */
export function registerStudioApp(
  api: PluginAPI,
  deps: { coordinator: ThesisCoordinator; options: CoordinatorOptions; lock: WorkspaceLock },
): boolean {
  if (!api.apps) return false;
  const service = new StudioService({ api, ...deps });
  try {
    api.apps.register({
      id: "studio",
      label: { en: "Thesis Studio", es: "Estudio de tesis" },
      html: () => readFile(new URL("../embedded.html", import.meta.url), "utf8"),
      actions: buildActions(service),
      busy: () => service.busy(),
      dispose: () => service.dispose(),
    });
    return true;
  } catch {
    service.dispose();
    return false;
  }
}
