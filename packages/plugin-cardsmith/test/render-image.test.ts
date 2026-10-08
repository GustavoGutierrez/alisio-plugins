import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_IMAGE_BYTES } from "../src/core/limits.js";
import type { Scene } from "../src/core/scene.js";
import { loadImageInputs } from "../src/renderers/image-input.js";
import { renderScene } from "../src/renderers/skia.js";
import { captureAsyncError } from "./helpers.js";
import { decodeRendered, isNear, pixelAt } from "./render-helpers.js";

function solidPng(width: number, height: number, color: string): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

describe("input images", () => {
  it("decodes inputs and renders fit cover with a circular clip", async () => {
    const data = solidPng(48, 48, "#00c853");
    const images = await loadImageInputs([{ id: "photo", data }]);
    expect(images.get("photo")?.width).toBe(48);
    expect(images.get("photo")?.height).toBe(48);

    const scene: Scene = {
      width: 200,
      height: 120,
      background: "#ffffff",
      ops: [
        { op: "image", ref: "photo", x: 20, y: 20, w: 80, h: 80, fit: "cover", round: "circle" },
      ],
    };
    const rendered = await renderScene(scene, { format: "png", images });
    const pixels = await decodeRendered(rendered);
    expect(isNear(pixelAt(pixels, 60, 60), [0, 200, 83], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 60, 22), [0, 200, 83], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 22, 22), [255, 255, 255], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 98, 98), [255, 255, 255], 3)).toBe(true);
  });

  it("rejects an input above the per-image byte budget", async () => {
    const big = new Uint8Array(MAX_INPUT_IMAGE_BYTES + 1);
    const error = await captureAsyncError(() => loadImageInputs([{ id: "big", data: big }]));
    expect(error.code).toBe("IMAGE_TOO_LARGE");
    expect(error.details?.bytes).toBe(MAX_INPUT_IMAGE_BYTES + 1);
  });

  it("rejects bytes that are not a decodable image", async () => {
    const error = await captureAsyncError(() =>
      loadImageInputs([{ id: "bad", data: Uint8Array.of(1, 2, 3, 4, 5) }]),
    );
    expect(error.code).toBe("IMAGE_DECODE_FAILED");
    expect(error.details?.id).toBe("bad");
  });

  it("rejects a list above the summed input byte budget", async () => {
    const twentyMegabytes = new Uint8Array(MAX_INPUT_IMAGE_BYTES);
    const error = await captureAsyncError(() =>
      loadImageInputs([
        { id: "a", data: twentyMegabytes },
        { id: "b", data: twentyMegabytes },
        { id: "c", data: twentyMegabytes },
        { id: "d", data: Uint8Array.of(1) },
      ]),
    );
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(error.details?.reason).toBe("input_total_bytes");
  });
});
