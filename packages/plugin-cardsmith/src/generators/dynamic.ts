import type { SpecError } from "../core/design-spec.js";
import { composeScene } from "../core/layout.js";
import {
  hasNonEmptyText,
  imageOpsForLayout,
  requireLayout,
  specError,
  withInjectedOps,
} from "./shared.js";
import type { FamilyGenerator } from "./types.js";

export const dynamicGenerator: FamilyGenerator = {
  family: "dynamic",

  validate(spec) {
    const errors: SpecError[] = [];
    if (spec.templateId === "inventory-product") {
      if (!hasNonEmptyText(spec.content, "productName")) {
        errors.push(
          specError("content.productName", "inventory-product requires a non-empty productName"),
        );
      }
      if (!hasNonEmptyText(spec.content, "price")) {
        errors.push(specError("content.price", "inventory-product requires a non-empty price"));
      }
    }
    if (spec.templateId === "status-card") {
      if (!hasNonEmptyText(spec.content, "title")) {
        errors.push(specError("content.title", "status-card requires a non-empty title"));
      }
      if (!hasNonEmptyText(spec.content, "status")) {
        errors.push(specError("content.status", "status-card requires a non-empty status"));
      }
    }
    return errors;
  },

  compose(spec, ctx) {
    const template = ctx.registry.template(spec.templateId);
    const size = ctx.registry.size(spec.sizeId);
    const layoutKey = size.orientation;
    const layout = requireLayout(template, layoutKey);
    const palette = ctx.registry.palette(spec.paletteId);
    // Snapshots are pure: no clock, no randomness. `updatedLabel` (and every other optional
    // slot) renders only when the explicit content carries it; composeScene skips absent keys.
    const composed = composeScene(template, layoutKey, spec, palette, ctx.registry, {
      measurer: ctx.measurer,
    });
    const injected =
      spec.templateId === "inventory-product" ? imageOpsForLayout(layout, spec, size) : [];
    return {
      scene: withInjectedOps(composed.scene, injected),
      warnings: composed.warnings,
    };
  },
};
