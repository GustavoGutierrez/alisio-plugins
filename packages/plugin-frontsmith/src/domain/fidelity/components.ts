import type { Rect } from "./integral.js";

/**
 * Area of the largest 4-connected group of set pixels inside `region` (the whole image when
 * omitted). Iterative, so a large mask cannot overflow the call stack.
 */
export function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number,
  region: Rect = { x: 0, y: 0, width, height },
): number {
  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(width, region.x + region.width);
  const y1 = Math.min(height, region.y + region.height);
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  let best = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const start = y * width + x;
      if (seen[start] || !mask[start]) continue;
      let area = 0;
      seen[start] = 1;
      stack.push(start);
      while (stack.length > 0) {
        const at = stack.pop() as number;
        area += 1;
        const px = at % width;
        const py = (at - px) / width;
        const visit = (nx: number, ny: number): void => {
          if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) return;
          const next = ny * width + nx;
          if (seen[next] || !mask[next]) return;
          seen[next] = 1;
          stack.push(next);
        };
        visit(px - 1, py);
        visit(px + 1, py);
        visit(px, py - 1);
        visit(px, py + 1);
      }
      if (area > best) best = area;
    }
  return best;
}
