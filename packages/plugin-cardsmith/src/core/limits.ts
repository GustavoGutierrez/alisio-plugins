import { CardsmithError } from "./errors.js";

/** Hard budget for a single render (width * height). */
export const MAX_RENDER_PIXELS = 12_000_000;

/** Budget for one input image. */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/** Summed budget for every input image of one render. */
export const MAX_TOTAL_INPUT_BYTES = 60 * 1024 * 1024;

/** Initial render worker concurrency. */
export const RENDER_CONCURRENCY = 2;

/** Initial bounded queue capacity in front of the render workers. */
export const RENDER_QUEUE_CAPACITY = 8;

/** Minimum QR module size in pixels for digital presets. */
export const QR_MIN_MODULE_PX = 4;

/** Mandatory quiet zone on every side of a QR symbol, in modules. */
export const QR_QUIET_ZONE_MODULES = 4;

/** Reject widths/heights that are not positive integers or exceed {@link MAX_RENDER_PIXELS}. */
export function assertRenderBudget(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new CardsmithError("LIMIT_EXCEEDED", "Render dimensions must be positive integers", {
      width,
      height,
    });
  }
  const pixels = width * height;
  if (pixels > MAX_RENDER_PIXELS) {
    throw new CardsmithError(
      "LIMIT_EXCEEDED",
      `Render of ${width}x${height} (${pixels} px) exceeds the ${MAX_RENDER_PIXELS} px budget`,
      { width, height, pixels, maxPixels: MAX_RENDER_PIXELS },
    );
  }
}

/** Reject a single input image that is not a valid non-negative size within budget. */
export function assertInputImageBudget(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new CardsmithError(
      "IMAGE_TOO_LARGE",
      "Input image size must be a non-negative finite number of bytes",
      { bytes },
    );
  }
  if (bytes > MAX_INPUT_IMAGE_BYTES) {
    throw new CardsmithError(
      "IMAGE_TOO_LARGE",
      `Input image of ${bytes} bytes exceeds the ${MAX_INPUT_IMAGE_BYTES} byte budget`,
      { bytes, maxBytes: MAX_INPUT_IMAGE_BYTES },
    );
  }
}
