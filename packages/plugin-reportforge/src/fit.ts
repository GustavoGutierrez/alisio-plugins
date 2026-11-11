/**
 * Fit-to-one-page geometry. The studio measures the rendered document at the printable width of
 * the chosen sheet; this module turns that measurement into a single zoom factor so the whole
 * report prints on one page without clipping. Zoom keeps text and SVG as vectors (no raster).
 */
import type { PageSize } from "./types.js";

/** CSS pixels per millimetre (96 px per inch). */
const PX_PER_MM = 96 / 25.4;
/** Page margin used for every printed page, in millimetres (matches `@page` in `render.ts`). */
export const PAGE_MARGIN_MM = 12;
/** Below this zoom, body text (15 px) prints under about 6 pt: the studio warns the user. */
export const LEGIBLE_SCALE = 0.55;
/** Never shrink further than this; past it the page is unreadable and a multipage PDF is better. */
export const MIN_SCALE = 0.2;

const SHEETS_MM: Record<PageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
};

/** Printable area of a sheet in CSS pixels, rounded down so content never touches the margin. */
export function printableArea(pageSize: PageSize): { width: number; height: number } {
  const sheet = SHEETS_MM[pageSize];
  return {
    width: Math.floor((sheet.width - 2 * PAGE_MARGIN_MM) * PX_PER_MM),
    height: Math.floor((sheet.height - 2 * PAGE_MARGIN_MM) * PX_PER_MM),
  };
}

export interface FitResult {
  scale: number;
  /** True when the scale is below `LEGIBLE_SCALE`. */
  small: boolean;
  /** True when even `MIN_SCALE` does not fit (the page would be clipped): print as multipage. */
  overflow: boolean;
}

/**
 * Largest zoom in (0, 1] at which content measured as `width` x `height` CSS pixels (laid out at
 * the printable width) fits the printable area. Deterministic: the result is floored to 1/1000 so
 * rounding never makes the content one pixel too tall.
 */
export function fitScale(pageSize: PageSize, width: number, height: number): FitResult {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("invalid_measurement");
  }
  const area = printableArea(pageSize);
  const raw = Math.min(1, area.width / width, area.height / height);
  const scale = Math.max(MIN_SCALE, Math.floor(raw * 1000) / 1000);
  return { scale, small: scale < LEGIBLE_SCALE, overflow: raw < MIN_SCALE };
}
