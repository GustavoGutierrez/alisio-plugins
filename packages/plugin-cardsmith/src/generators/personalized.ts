import type { SpecError } from "../core/design-spec.js";
import { composeScene } from "../core/layout.js";
import { type Palette, paletteToken } from "../core/palettes.js";
import type { PathOp } from "../core/scene.js";
import type { SizePreset } from "../core/sizes.js";
import {
  hasNonEmptyText,
  imageOpsForLayout,
  requireLayout,
  roundedRectPathData,
  specError,
  withInjectedOps,
} from "./shared.js";
import type { FamilyGenerator } from "./types.js";

/** Frame geometry in `u` units: `u = min(width, height) / 100`. */
const OUTER_INSET_UNITS = 3;
const INNER_INSET_UNITS = 4.5;
const FRAME_RADIUS_UNITS = 1;
const OUTER_STROKE_UNITS = 0.4;
const INNER_STROKE_UNITS = 0.25;

/**
 * Inset double frame: outer `$primary` ring and inner `$accent` ring, drawn as stroked rounded
 * rectangles. `RectOp` has no stroke, so the frame uses `path` ops with rounded-rect data.
 */
function certificateFrameOps(size: SizePreset, palette: Palette): PathOp[] {
  const unit = Math.min(size.width, size.height) / 100;
  const ring = (insetUnits: number, stroke: string, strokeUnits: number): PathOp => {
    const inset = insetUnits * unit;
    return {
      op: "path",
      d: roundedRectPathData(
        inset,
        inset,
        size.width - 2 * inset,
        size.height - 2 * inset,
        FRAME_RADIUS_UNITS * unit,
      ),
      stroke,
      strokeWidth: strokeUnits * unit,
    };
  };
  return [
    ring(OUTER_INSET_UNITS, paletteToken(palette.tokens, "primary"), OUTER_STROKE_UNITS),
    ring(INNER_INSET_UNITS, paletteToken(palette.tokens, "accent"), INNER_STROKE_UNITS),
  ];
}

export const personalizedGenerator: FamilyGenerator = {
  family: "personalized",

  validate(spec) {
    const errors: SpecError[] = [];
    if (
      spec.templateId === "certificate-classic" &&
      !hasNonEmptyText(spec.content, "recipientName")
    ) {
      errors.push(
        specError(
          "content.recipientName",
          "certificate-classic requires a non-empty recipientName",
        ),
      );
    }
    return errors;
  },

  compose(spec, ctx) {
    const template = ctx.registry.template(spec.templateId);
    const size = ctx.registry.size(spec.sizeId);
    const layoutKey = size.orientation;
    const layout = requireLayout(template, layoutKey);
    const palette = ctx.registry.palette(spec.paletteId);
    const composed = composeScene(template, layoutKey, spec, palette, ctx.registry, {
      measurer: ctx.measurer,
    });
    // certificate-classic keeps its laurel/seal decor and gains the frame; badge-clean and
    // banner-promo place their optional image slot (photo/product) when the spec provides it.
    const injected =
      spec.templateId === "certificate-classic"
        ? certificateFrameOps(size, palette)
        : imageOpsForLayout(layout, spec, size);
    return {
      scene: withInjectedOps(composed.scene, injected),
      warnings: composed.warnings,
    };
  },
};
