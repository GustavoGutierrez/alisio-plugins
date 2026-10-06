import { largestComponent } from "./components.js";
import { integralImage, maxWindow, type Rect } from "./integral.js";

/**
 * 1 where any RGBA channel of two same-size images differs by more than `tolerance` (an integer
 * 0 to 255, set by calibration). All arithmetic is integer (spec 11.3).
 */
export function diffMask(
  reference: Uint8Array,
  actual: Uint8Array,
  width: number,
  height: number,
  tolerance = 0,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const at = pixel * 4;
    for (let c = 0; c < 4; c += 1)
      if (Math.abs((reference[at + c] as number) - (actual[at + c] as number)) > tolerance) {
        mask[pixel] = 1;
        break;
      }
  }
  return mask;
}

/** 1 for every pixel outside the masks: masked pixels leave numerator and denominator (spec 11.3). */
export function validPixels(width: number, height: number, masks: readonly Rect[]): Uint8Array {
  const valid = new Uint8Array(width * height).fill(1);
  for (const box of masks)
    for (
      let y = Math.max(0, Math.floor(box.y));
      y < Math.min(height, Math.ceil(box.y + box.height));
      y += 1
    )
      for (
        let x = Math.max(0, Math.floor(box.x));
        x < Math.min(width, Math.ceil(box.x + box.width));
        x += 1
      )
        valid[y * width + x] = 0;
  return valid;
}

/** Share of differing pixels over the whole image, as a percentage of matching pixels (diagnostic only). */
export const globalMatchPercent = (mask: Uint8Array): number => {
  let differing = 0;
  for (const value of mask) differing += value ? 1 : 0;
  return 100 * (1 - differing / mask.length);
};

export interface RegionMetrics {
  /** Differing pixels over valid pixels of the region; 0 when no pixel is valid. */
  dR: number;
  /** Largest k by k window density inside the region. */
  qK: number;
  /** The window size used (smaller than `k` for a smaller region). */
  k: number;
  /** Area of the largest 4-connected group of differing pixels. */
  largestComponent: number;
  validPixels: number;
  differingPixels: number;
}

/** The metrics of one region (FID, spec 11.3): no pre-rounding, ratios stay unrounded. */
export function regionMetrics(
  mask: Uint8Array,
  valid: Uint8Array,
  width: number,
  height: number,
  region: Rect,
  k: number,
): RegionMetrics {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(width, Math.ceil(region.x + region.width));
  const y1 = Math.min(height, Math.ceil(region.y + region.height));
  const clipped: Rect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  let validCount = 0;
  let differing = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const at = y * width + x;
      if (!valid[at]) continue;
      validCount += 1;
      if (mask[at]) differing += 1;
    }
  if (clipped.width === 0 || clipped.height === 0 || validCount === 0)
    return {
      dR: 0,
      qK: 0,
      k,
      largestComponent: 0,
      validPixels: validCount,
      differingPixels: differing,
    };
  // Masked pixels never count as differences, so they are cleared before the windows are summed.
  const effective = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) effective[i] = mask[i] && valid[i] ? 1 : 0;
  const window = maxWindow(integralImage(effective, width, height), width, clipped, k);
  return {
    dR: differing / validCount,
    qK: window.count / (window.k * window.k),
    k: window.k,
    largestComponent: largestComponent(effective, width, height, clipped),
    validPixels: validCount,
    differingPixels: differing,
  };
}
