import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Scene } from "../src/core/scene.js";
import type { CanvasImage } from "../src/renderers/image-input.js";
import { type RenderedImage, renderScene } from "../src/renderers/skia.js";
import { packagePath } from "../src/resource-paths.js";

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PixelRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Copy a decoded image into a fresh canvas and read its RGBA pixels. */
export function readPixels(image: CanvasImage): PixelBuffer {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, image.width, image.height);
  return { data: imageData.data, width: imageData.width, height: imageData.height };
}

export async function decodeRendered(rendered: RenderedImage): Promise<PixelBuffer> {
  return readPixels(await loadImage(Buffer.from(rendered.bytes)));
}

/** Encoded solid-color PNG bytes, for APIs that consume image data instead of decoded images. */
export function solidPngBytes(width: number, height: number, color: string): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** In-memory solid-color PNG decoded once, for scenes whose image ops need an input fixture. */
export async function solidImage(
  width: number,
  height: number,
  color: string,
): Promise<CanvasImage> {
  return loadImage(Buffer.from(solidPngBytes(width, height, color)));
}

/**
 * Render a scene at preview scale, decoding one in-memory fixture per distinct image op ref.
 * Family cards place user input images, so renders must inject those refs or the renderer throws
 * UNKNOWN_ASSET.
 */
export async function renderWithFixtures(scene: Scene, scale = 0.25): Promise<RenderedImage> {
  const refs = new Set<string>();
  for (const op of scene.ops) {
    if (op.op === "image") refs.add(op.ref);
  }
  const images = new Map<string, CanvasImage>();
  for (const ref of refs) {
    images.set(ref, await solidImage(64, 64, "#3366cc"));
  }
  return renderScene(scene, { format: "png", scale, images });
}

export function pixelAt(
  buffer: PixelBuffer,
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * buffer.width + x) * 4;
  return [
    buffer.data[index] ?? 0,
    buffer.data[index + 1] ?? 0,
    buffer.data[index + 2] ?? 0,
    buffer.data[index + 3] ?? 0,
  ];
}

/** Compare RGB channels ignoring alpha, which stays opaque for scene renders. */
export function isNear(
  actual: readonly [number, number, number, number],
  expected: readonly [number, number, number],
  tolerance = 3,
): boolean {
  return (
    Math.abs(actual[0] - expected[0]) <= tolerance &&
    Math.abs(actual[1] - expected[1]) <= tolerance &&
    Math.abs(actual[2] - expected[2]) <= tolerance
  );
}

/** Count pixels that are not near white, optionally restricted to a region. */
export function countInk(buffer: PixelBuffer, region?: PixelRegion): number {
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const x1 = region === undefined ? buffer.width : Math.min(buffer.width, region.x + region.w);
  const y1 = region === undefined ? buffer.height : Math.min(buffer.height, region.y + region.h);
  let ink = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const [r, g, b] = pixelAt(buffer, x, y);
      if (r < 245 || g < 245 || b < 245) ink += 1;
    }
  }
  return ink;
}

export interface FontRoleEntry {
  alias: string;
  file: string;
  weight: number;
  family: string;
}

/** Unique `{ alias, file, weight }` role entries declared by the packaged font pairs. */
export function fontRoleEntries(): FontRoleEntry[] {
  const raw = JSON.parse(readFileSync(packagePath("resources/font-pairs.json"), "utf8")) as Array<{
    roles: Record<string, FontRoleEntry>;
  }>;
  const byAlias = new Map<string, FontRoleEntry>();
  for (const pair of raw) {
    for (const role of Object.values(pair.roles)) {
      if (!byAlias.has(role.alias)) byAlias.set(role.alias, role);
    }
  }
  return [...byAlias.values()].sort((a, b) => (a.alias < b.alias ? -1 : 1));
}
