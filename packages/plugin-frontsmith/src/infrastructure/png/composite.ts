import { cropImage, type PngImage } from "../../domain/fidelity/image.js";
import { diffMask } from "../../domain/fidelity/regions.js";
import { drawText, GLYPH_HEIGHT, textWidth } from "./bitmap-font.js";
import { encodePng } from "./encode.js";

export interface RegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 8;
const LABEL_STRIP = 24;
const MAGENTA: [number, number, number, number] = [255, 0, 255, 255];
const OUTLINE: [number, number, number, number] = [0, 160, 255, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const STRIP: [number, number, number, number] = [17, 17, 17, 255];

/** Nearest-neighbour reduction by a whole factor: every output pixel is one exact input pixel. */
export function downscale(image: PngImage, factor: number): PngImage {
  if (factor === 1) return image;
  const width = Math.ceil(image.width / factor);
  const height = Math.ceil(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const from = (y * factor * image.width + x * factor) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  return { width, height, data };
}

/** Place an image on a white canvas of the given size (the smaller of two compared captures). */
function pad(image: PngImage, width: number, height: number): PngImage {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(WHITE, i);
  for (let y = 0; y < Math.min(height, image.height); y += 1)
    data.set(
      image.data.subarray(
        y * image.width * 4,
        (y * image.width + Math.min(width, image.width)) * 4,
      ),
      y * width * 4,
    );
  return { width, height, data };
}

/**
 * Differing pixels in magenta over a 40 percent gray version of the actual capture (a washed-out
 * copy: gray at 40 percent opacity over white); the rest of the panel shows the actual image.
 */
function diffPanel(reference: PngImage, actual: PngImage, tolerance: number): PngImage {
  const mask = diffMask(reference.data, actual.data, reference.width, reference.height, tolerance);
  const data = new Uint8Array(actual.data.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const at = pixel * 4;
    if (mask[pixel]) {
      data.set(MAGENTA, at);
      continue;
    }
    const gray = Math.round(
      0.299 * (actual.data[at] as number) +
        0.587 * (actual.data[at + 1] as number) +
        0.114 * (actual.data[at + 2] as number),
    );
    const washed = Math.round(gray * 0.4 + 255 * 0.6);
    data.set([washed, washed, washed, 255], at);
  }
  return { width: reference.width, height: reference.height, data };
}

function outline(image: PngImage, box: RegionBox, scale: number): void {
  const x0 = Math.floor(box.x / scale);
  const y0 = Math.floor(box.y / scale);
  const x1 = Math.ceil((box.x + box.width) / scale) - 1;
  const y1 = Math.ceil((box.y + box.height) / scale) - 1;
  const paint = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < image.width && y < image.height)
      image.data.set(OUTLINE, (y * image.width + x) * 4);
  };
  for (let thickness = 0; thickness < 2; thickness += 1) {
    for (let x = x0; x <= x1; x += 1) {
      paint(x, y0 + thickness);
      paint(x, y1 - thickness);
    }
    for (let y = y0; y <= y1; y += 1) {
      paint(x0 + thickness, y);
      paint(x1 - thickness, y);
    }
  }
}

export interface ComposeInput {
  reference: PngImage;
  actual: PngImage;
  maxWidth: number;
  /** The encoded file stays below this size by further whole-number downscaling. */
  maxBytes: number;
  channelTolerance: number;
  regions?: readonly RegionBox[];
}

export interface Composite {
  image: PngImage;
  png: Uint8Array;
  /** The whole-number reduction applied to every panel. */
  scale: number;
}

function compose(input: ComposeInput, scale: number): PngImage {
  const width = Math.max(input.reference.width, input.actual.width);
  const height = Math.max(input.reference.height, input.actual.height);
  const reference = pad(input.reference, width, height);
  const actual = pad(input.actual, width, height);
  const diff = diffPanel(reference, actual, input.channelTolerance);
  for (const box of input.regions ?? []) outline(diff, box, 1);
  const panels = [reference, actual, diff].map((panel) => downscale(panel, scale));
  const panelW = (panels[0] as PngImage).width;
  const panelH = (panels[0] as PngImage).height;
  const totalW = panelW * 3 + GAP * 2;
  const data = new Uint8Array(totalW * (LABEL_STRIP + panelH) * 4);
  for (let i = 0; i < data.length; i += 4) data.set(WHITE, i);
  const image: PngImage = { width: totalW, height: LABEL_STRIP + panelH, data };
  for (let y = 0; y < LABEL_STRIP; y += 1)
    for (let x = 0; x < totalW; x += 1) image.data.set(STRIP, (y * totalW + x) * 4);
  const labels = ["REFERENCE", "ACTUAL", "DIFF"];
  panels.forEach((panel, index) => {
    const left = index * (panelW + GAP);
    for (let y = 0; y < panelH; y += 1)
      image.data.set(
        panel.data.subarray(y * panelW * 4, (y + 1) * panelW * 4),
        ((LABEL_STRIP + y) * totalW + left) * 4,
      );
    const label = labels[index] as string;
    const textScale = 2;
    const w = textWidth(label, textScale);
    drawText(
      image,
      left + Math.max(0, Math.floor((panelW - w) / 2)),
      Math.floor((LABEL_STRIP - GLYPH_HEIGHT * textScale) / 2),
      label,
      WHITE,
      textScale,
    );
  });
  return image;
}

/**
 * The evidence image of spec 11.5: reference, actual and diff side by side under a label strip.
 * The panels are reduced by whole numbers until the width fits and the PNG is below the byte cap.
 */
export function composeEvidence(input: ComposeInput): Composite {
  const width = Math.max(input.reference.width, input.actual.width);
  let scale = 1;
  while ((width / scale) * 3 + GAP * 2 > input.maxWidth && Math.ceil(width / scale) > 1) scale += 1;
  for (;;) {
    const image = compose(input, scale);
    const png = encodePng(image);
    const smallest = image.width <= GAP * 2 + 3;
    if (png.length <= input.maxBytes || smallest) return { image, png, scale };
    scale += 1;
  }
}

/** A crop of one region, encoded below `maxBytes` (web evidence crops stay under 500 KB). */
export function cropEvidence(
  image: PngImage,
  rect: RegionBox,
  maxBytes: number,
): Uint8Array | undefined {
  const cropped = cropImage(image, rect);
  if (!cropped) return undefined;
  for (let scale = 1; ; scale += 1) {
    const png = encodePng(downscale(cropped, scale));
    if (png.length <= maxBytes || Math.ceil(cropped.width / scale) <= 1) return png;
  }
}
