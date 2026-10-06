import type { PluginAPI } from "@alisio/sdk";
import type { FrontsmithServices } from "../../application/services.js";
import { isFeatureId } from "../../domain/ids.js";

/**
 * View `frontsmith-state`: the feature list, or one feature with its next command, as JSON. It is
 * for forward compatibility only (spec 18.1): nothing required depends on it, and a host without
 * views, or one that rejects the registration, is not an error.
 */
export function registerViews(api: PluginAPI, services: FrontsmithServices): void {
  try {
    api.views?.register({
      id: "frontsmith-state",
      description: "Frontsmith features, phases and gates as JSON.",
      params: {
        type: "object",
        properties: { feature: { type: "string" } },
        additionalProperties: false,
      },
      async handler(params, context) {
        const feature = params.feature;
        if (typeof feature === "string" && feature !== "") {
          if (!isFeatureId(feature)) throw new Error("Invalid feature id");
          const status = await services.workflow.status(context.workspace, feature);
          return { state: status.state, next: status.next, running: status.running };
        }
        const features = await services.workflow.list(context.workspace);
        return {
          features: features.map((s) => ({
            feature: s.feature,
            level: s.level,
            phase: s.phase,
            blocked: s.blocked?.reason ?? null,
          })),
        };
      },
    });
  } catch {
    // Views are optional.
  }
}
