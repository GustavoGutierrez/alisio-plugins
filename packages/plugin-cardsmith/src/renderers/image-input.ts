import { loadImage } from "@napi-rs/canvas";
import { CardsmithError } from "../core/errors.js";
import {
  assertInputImageBudget,
  MAX_RENDER_PIXELS,
  MAX_TOTAL_INPUT_BYTES,
} from "../core/limits.js";

export type CanvasImage = Awaited<ReturnType<typeof loadImage>>;

export interface ImageInput {
  id: string;
  data: Uint8Array;
}

/**
 * Decode the input images of one render. Per-image bytes, the summed input budget and the decoded
 * pixel count are all bounded before the image is handed to the renderer, so a small compressed
 * file cannot trigger a huge allocation.
 */
export async function loadImageInputs(inputs: ImageInput[]): Promise<Map<string, CanvasImage>> {
  let totalBytes = 0;
  for (const input of inputs) {
    if (typeof input.id !== "string" || input.id.length === 0) {
      throw new CardsmithError("INVALID_SPEC", "Input image id must be a non-empty string", {
        id: input.id,
      });
    }
    assertInputImageBudget(input.data.byteLength);
    totalBytes += input.data.byteLength;
  }
  if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
    throw new CardsmithError(
      "LIMIT_EXCEEDED",
      `Input images total ${totalBytes} bytes, exceeding the ${MAX_TOTAL_INPUT_BYTES} byte budget`,
      { reason: "input_total_bytes", totalBytes, maxBytes: MAX_TOTAL_INPUT_BYTES },
    );
  }

  const images = new Map<string, CanvasImage>();
  for (const input of inputs) {
    let image: CanvasImage;
    try {
      image = await loadImage(Buffer.from(input.data));
    } catch (error) {
      throw new CardsmithError(
        "IMAGE_DECODE_FAILED",
        `Input image "${input.id}" could not be decoded`,
        { id: input.id, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const pixels = image.width * image.height;
    if (pixels > MAX_RENDER_PIXELS) {
      throw new CardsmithError(
        "IMAGE_TOO_LARGE",
        `Input image "${input.id}" decodes to ${image.width}x${image.height} (${pixels} px), exceeding the ${MAX_RENDER_PIXELS} px budget`,
        {
          id: input.id,
          width: image.width,
          height: image.height,
          pixels,
          maxPixels: MAX_RENDER_PIXELS,
        },
      );
    }
    images.set(input.id, image);
  }
  return images;
}
