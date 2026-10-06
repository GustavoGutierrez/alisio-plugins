/** 8-bit RGBA pixels, row major: the only image shape the fidelity pipeline works with. */
export interface PngImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The pixels of a rectangle, clipped to the image; `undefined` when nothing of it is inside. */
export function cropImage(
  image: PngImage,
  rect: { x: number; y: number; width: number; height: number },
): PngImage | undefined {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return undefined;
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    data.set(
      image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4),
      y * width * 4,
    );
  return { width, height, data };
}
