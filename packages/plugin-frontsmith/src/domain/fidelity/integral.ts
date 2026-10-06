/**
 * Summed-area table of a 0/1 mask: `table[(y + 1) * (width + 1) + x + 1]` is the number of set
 * pixels in the rectangle from (0,0) to (x,y). Every window sum is then four lookups (spec 11.3).
 */
export function integralImage(mask: Uint8Array, width: number, height: number): Uint32Array {
  const stride = width + 1;
  const table = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += (mask[y * width + x] as number) !== 0 ? 1 : 0;
      table[(y + 1) * stride + x + 1] = (table[y * stride + x + 1] as number) + rowSum;
    }
  }
  return table;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Set pixels inside a rectangle (clipped to the image). */
export function rectSum(table: Uint32Array, imageWidth: number, rect: Rect): number {
  const stride = imageWidth + 1;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  return (
    (table[y1 * stride + x1] as number) -
    (table[y0 * stride + x1] as number) -
    (table[y1 * stride + x0] as number) +
    (table[y0 * stride + x0] as number)
  );
}

export interface WindowMax {
  count: number;
  x: number;
  y: number;
  /** The window size actually used: `k`, or the region's smaller side when it is smaller than `k`. */
  k: number;
}

/**
 * The largest number of set pixels in any k by k window fully inside `region`. A region smaller
 * than the window uses its own smaller side. The caller divides by k squared for a density.
 */
export function maxWindow(
  table: Uint32Array,
  imageWidth: number,
  region: Rect,
  k: number,
): WindowMax {
  const size = Math.max(1, Math.min(k, region.width, region.height));
  let best: WindowMax = { count: 0, x: region.x, y: region.y, k: size };
  for (let y = region.y; y + size <= region.y + region.height; y += 1)
    for (let x = region.x; x + size <= region.x + region.width; x += 1) {
      const count = rectSum(table, imageWidth, { x, y, width: size, height: size });
      if (count > best.count) best = { count, x, y, k: size };
    }
  return best;
}
