import type { NormalizedSpec, SpecError } from "../core/design-spec.js";
import { composeScene } from "../core/layout.js";
import { type Palette, paletteToken } from "../core/palettes.js";
import type { TemplateLayout } from "../core/registry.js";
import type { GroupOp, ImageOp, RectOp, SceneOp, TextOp } from "../core/scene.js";
import type { SizePreset } from "../core/sizes.js";
import { type ResolvedFont, resolveRole } from "../core/typography.js";
import {
  boxToPx,
  contentFrame,
  imageOpsForLayout,
  missingImages,
  requireLayout,
  specError,
  withInjectedOps,
} from "./shared.js";
import type { FamilyGenerator } from "./types.js";

/** Templates that own a single full-bleed `photo`. */
const SINGLE_PHOTO_TEMPLATES = new Set(["photo-caption", "watermark"]);

/** Bottom band opacity over the photo: enough contrast for text, photo still visible. */
const SCRIM_ALPHA = 0.55;

/** Diagonal watermark tiling. */
const WATERMARK_ANGLE_DEG = -30;
const WATERMARK_SIZE_PCT = 7;
const WATERMARK_SHADOW_ALPHA = 0.22;
const WATERMARK_MAIN_ALPHA = 0.3;
const WATERMARK_SHADOW_OFFSET = 2;

/**
 * `photo-caption` and `watermark` make their single `photo` the full-bleed background: the whole
 * canvas, bypassing the story safe area (`isFullBleedBox` semantics). The template image slot
 * contributes `fit`/`round`; the family contract fixes the box.
 */
function fullBleedPhotoOps(
  spec: NormalizedSpec,
  layout: TemplateLayout,
  size: SizePreset,
): ImageOp[] {
  const image = spec.images.find((entry) => entry.id === "photo");
  if (image === undefined) return [];
  const slot = layout.imageSlots?.find((candidate) => candidate.key === "photo");
  const op: ImageOp = {
    op: "image",
    ref: image.id,
    x: 0,
    y: 0,
    w: size.width,
    h: size.height,
    fit: slot?.fit ?? "cover",
  };
  if (slot?.round !== undefined) op.round = slot.round;
  return [op];
}

/**
 * Bottom legibility scrim over the full-bleed photo, covering the union of the layout text boxes
 * from 2u above the highest slot down to the canvas edge. Injecting it before the text keeps the
 * caption readable over any photo.
 */
function textBandScrim(layout: TemplateLayout, size: SizePreset, palette: Palette): RectOp | null {
  if (layout.slots.length === 0) return null;
  const frame = contentFrame(size);
  let minY = Number.POSITIVE_INFINITY;
  for (const slot of layout.slots) {
    minY = Math.min(minY, boxToPx(slot.box, frame).y);
  }
  if (!Number.isFinite(minY)) return null;
  const unit = Math.min(size.width, size.height) / 100;
  const top = Math.max(0, minY - 2 * unit);
  return {
    op: "rect",
    x: 0,
    y: top,
    w: size.width,
    h: size.height - top,
    fill: paletteToken(palette.tokens, "background"),
    alpha: SCRIM_ALPHA,
  };
}

/**
 * Diagonal tiled watermark: 3 to 6 repetitions of `watermarkText` along a line through the canvas
 * center at -30°, spaced about one third of the short side. Each repetition is a rotated group
 * containing a `$text` shadow (offset, low alpha) and the `$background` main text. Both alphas
 * stay low so the photo remains the protagonist.
 */
function watermarkOps(
  text: string,
  size: SizePreset,
  palette: Palette,
  font: ResolvedFont,
): GroupOp[] {
  const shortSide = Math.min(size.width, size.height);
  const spacing = shortSide / 3;
  const diagonal = Math.hypot(size.width, size.height);
  const count = Math.min(6, Math.max(3, Math.round(diagonal / spacing)));
  const sizePx = Math.round((WATERMARK_SIZE_PCT / 100) * shortSide);
  const lineHeight = sizePx * 1.25;
  const radians = (WATERMARK_ANGLE_DEG * Math.PI) / 180;
  const direction = { x: Math.cos(radians), y: Math.sin(radians) };
  const centerX = size.width / 2;
  const centerY = size.height / 2;
  const shadowColor = paletteToken(palette.tokens, "text");
  const mainColor = paletteToken(palette.tokens, "background");
  const maxWidth = Math.max(size.width, size.height);
  const ops: GroupOp[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * spacing;
    const x = centerX + offset * direction.x;
    const y = centerY + offset * direction.y;
    const shadow: TextOp = {
      op: "text",
      text,
      x: x + WATERMARK_SHADOW_OFFSET,
      y: y + WATERMARK_SHADOW_OFFSET,
      font,
      sizePx,
      color: shadowColor,
      align: "center",
      valign: "middle",
      lineHeight,
      lines: [text],
      maxWidth,
      alpha: WATERMARK_SHADOW_ALPHA,
    };
    const main: TextOp = {
      op: "text",
      text,
      x,
      y,
      font,
      sizePx,
      color: mainColor,
      align: "center",
      valign: "middle",
      lineHeight,
      lines: [text],
      maxWidth,
      alpha: WATERMARK_MAIN_ALPHA,
    };
    ops.push({
      op: "group",
      rotateDeg: WATERMARK_ANGLE_DEG,
      rotateX: x,
      rotateY: y,
      children: [shadow, main],
    });
  }
  return ops;
}

function watermarkTextOf(spec: NormalizedSpec): string | null {
  const value = spec.content.watermarkText;
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/** Required image keys of the collage layout: the first pair is mandatory, the rest optional. */
function collageRequiredKeys(layout: TemplateLayout): string[] {
  return (layout.imageSlots ?? []).slice(0, 2).map((slot) => slot.key);
}

export const compositeGenerator: FamilyGenerator = {
  family: "composite",

  validate(spec, ctx) {
    const errors: SpecError[] = [];
    if (SINGLE_PHOTO_TEMPLATES.has(spec.templateId)) {
      const count = spec.images.filter((image) => image.id === "photo").length;
      if (count !== 1) {
        const missing = missingImages(spec, ["photo"]);
        const detail =
          missing.length > 0
            ? `missing: ${missing.join(", ")}`
            : `found ${count} entries with the id "photo"`;
        errors.push(
          specError(
            "images",
            `${spec.templateId} requires exactly one image with the id "photo"; ${detail}`,
          ),
        );
      }
    }
    if (spec.templateId === "image-collage") {
      const template = ctx.registry.template(spec.templateId);
      const size = ctx.registry.size(spec.sizeId);
      const layout = template.layouts[size.orientation];
      const required = collageRequiredKeys(layout ?? { slots: [] });
      const missing = missingImages(spec, required);
      if (missing.length > 0) {
        errors.push(
          specError(
            "images",
            `image-collage requires at least the pair ${required.join(" + ")}; missing: ${missing.join(", ")}`,
          ),
        );
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
    const composed = composeScene(template, layoutKey, spec, palette, ctx.registry, {
      measurer: ctx.measurer,
    });
    const injected: SceneOp[] = [];

    if (spec.templateId === "photo-caption") {
      injected.push(...fullBleedPhotoOps(spec, layout, size));
      const scrim = textBandScrim(layout, size, palette);
      if (scrim !== null) injected.push(scrim);
    } else if (spec.templateId === "watermark") {
      injected.push(...fullBleedPhotoOps(spec, layout, size));
      const text = watermarkTextOf(spec);
      if (text !== null) {
        const font = resolveRole(ctx.registry.fontPair(spec.fontPairId), "display");
        injected.push(...watermarkOps(text, size, palette, font));
      }
    } else if (spec.templateId === "image-collage") {
      // Extra images with unknown ids are ignored silently: only declared slots are drawn.
      injected.push(...imageOpsForLayout(layout, spec, size));
    }

    return {
      scene: withInjectedOps(composed.scene, injected),
      warnings: composed.warnings,
    };
  },
};
