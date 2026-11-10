import type { PluginAPI } from "@alisio/sdk";
import { readState } from "./storage.js";

export interface ChildModel {
  /** Resolved `provider/model` reference for `ChildSessionSpec.model`; absent inherits. */
  model?: string;
  /** Set when the chosen model could not be used and the child inherits Alisio's model. */
  notice?: string;
}

/**
 * The model of the next child session (D7): the project's chosen model when the host resolves it,
 * otherwise nothing (the child inherits Alisio's active model) plus a notice. The stored choice is
 * never cleared here. A host without `api.models` counts as "not resolvable".
 */
export async function resolveChildModel(
  api: PluginAPI,
  workspace: string,
  parentId: string,
  signal?: AbortSignal,
): Promise<ChildModel> {
  let chosen: string | null | undefined;
  try {
    chosen = (await readState(workspace))?.settings?.model;
  } catch {
    chosen = undefined;
  }
  if (!chosen) return {};
  try {
    const models = (api as Partial<PluginAPI>).models;
    if (models?.resolve) {
      const resolved = await models.resolve(chosen, signal);
      if (resolved?.reference) return { model: resolved.reference };
    }
  } catch {
    // Fall through to the notice.
  }
  let active = "";
  try {
    active = api.sessions.model?.(parentId) ?? "";
  } catch {
    active = "";
  }
  return {
    notice: `the chosen model is not available; used ${active || "Alisio's active model"}`,
  };
}
