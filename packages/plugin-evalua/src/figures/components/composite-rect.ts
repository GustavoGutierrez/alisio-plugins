import { figureRoot, fmt, gridLine, intParam, label } from "../svg.js";
import type { FigureComponent } from "../types.js";

const BOX_W = 240;
const BOX_H = 160;
const PAD = 52;

/** The outline vertices (math coordinates) of a W x H rectangle with its top-right cw x ch cut. */
export function compositeVertices(
  width: number,
  height: number,
  cutWidth: number,
  cutHeight: number,
): Array<[number, number]> {
  if (cutWidth <= 0 || cutHeight <= 0) {
    return [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ];
  }
  return [
    [0, 0],
    [width, 0],
    [width, height - cutHeight],
    [width - cutWidth, height - cutHeight],
    [width - cutWidth, height],
    [0, height],
  ];
}

/**
 * A rectangle, or an L-shape (a rectangle with its top-right corner cut away), drawn to scale with
 * every side labelled by its length. `hidden` lists side indices (counter-clockwise from the
 * bottom) written as `?`; `grid: true` draws the unit squares for counting.
 */
export const compositeRect: FigureComponent = (params, title) => {
  const width = intParam(params.width, 6, 1, 999);
  const height = intParam(params.height, 4, 1, 999);
  const cutWidth = intParam(params.cutWidth, 0, 0, width - 1);
  const cutHeight = intParam(params.cutHeight, 0, 0, height - 1);
  const unit = typeof params.unit === "string" ? ` ${params.unit}` : "";
  const hidden = new Set(Array.isArray(params.hidden) ? params.hidden : []);
  const scale = Math.min(BOX_W / width, BOX_H / height);
  const sx = (x: number) => PAD + x * scale;
  const sy = (y: number) => PAD + BOX_H - y * scale;
  const vertices = compositeVertices(width, height, cutWidth, cutHeight);
  let body = `<polygon points="${vertices.map(([x, y]) => `${fmt(sx(x))},${fmt(sy(y))}`).join(" ")}"/>`;
  if (params.grid === true && width <= 20 && height <= 20) {
    for (let x = 1; x < width; x += 1) {
      const top = x > width - cutWidth ? height - cutHeight : height;
      body += gridLine(sx(x), sy(0), sx(x), sy(top));
    }
    for (let y = 1; y < height; y += 1) {
      const right = y > height - cutHeight ? width - cutWidth : width;
      body += gridLine(sx(0), sy(y), sx(right), sy(y));
    }
  }
  const sides: string[] = [];
  vertices.forEach(([x1, y1], index) => {
    const [x2, y2] = vertices[(index + 1) % vertices.length] ?? [0, 0];
    const length = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    const text = hidden.has(index) ? "?" : `${length}${unit}`;
    sides.push(text);
    const mx = sx((x1 + x2) / 2);
    const my = sy((y1 + y2) / 2);
    // The outward normal of a counter-clockwise outline points right of the travel direction.
    const nx = Math.sign(y2 - y1);
    const ny = -Math.sign(x2 - x1);
    body += label(mx + nx * 8, my - ny * 12 + 4, text, {
      size: 12,
      anchor: nx > 0 ? "start" : nx < 0 ? "end" : "middle",
    });
  });
  const shape = vertices.length === 4 ? "Rectángulo" : "Figura en forma de L";
  return figureRoot(
    BOX_W + 2 * PAD,
    BOX_H + 2 * PAD,
    body,
    title ?? shape,
    `Lados, desde la base en sentido antihorario: ${sides.join(", ")}.`,
  );
};
