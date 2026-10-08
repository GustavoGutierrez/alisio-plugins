import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { CardsmithError } from "../core/errors.js";
import type { ResolvedFont, TextMeasure, TextMeasurer } from "../core/typography.js";
import { registerFonts } from "./skia.js";

/** Shared offscreen context; one canvas for every measurement, never one per call. */
let sharedContext: SKRSContext2D | undefined;

function context(): SKRSContext2D {
  sharedContext ??= createCanvas(8, 8).getContext("2d");
  return sharedContext;
}

/**
 * Real Skia text measurer. Fonts are registered on creation so measurement and rendering resolve
 * the same faces. `actualBoundingBoxAscent`/`Descent` describe the drawn glyphs; when they are 0
 * (empty or blank text) the font bounding box is used instead.
 */
export function createTextMeasurer(): TextMeasurer {
  registerFonts();
  const ctx = context();
  return {
    measure(text: string, font: ResolvedFont, sizePx: number): TextMeasure {
      if (!Number.isFinite(sizePx) || sizePx <= 0) {
        throw new CardsmithError("INVALID_SPEC", `Text size must be positive, got ${sizePx}`, {
          sizePx,
        });
      }
      ctx.font = `${font.weight} ${sizePx}px "${font.alias}"`;
      const metrics = ctx.measureText(text);
      const ascent =
        metrics.actualBoundingBoxAscent !== 0
          ? metrics.actualBoundingBoxAscent
          : metrics.fontBoundingBoxAscent;
      const descent =
        metrics.actualBoundingBoxDescent !== 0
          ? metrics.actualBoundingBoxDescent
          : metrics.fontBoundingBoxDescent;
      return { width: metrics.width, ascent, descent };
    },
  };
}
