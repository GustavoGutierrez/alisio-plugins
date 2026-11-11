import { line, num, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A square grid from `-range` to `range` on both axes with unlabelled dotted `points`. */
export const cartesian: FigureComponent = (params) => {
  const size = 260;
  const pad = 30;
  const range = num(params.range, 5);
  const cx = pad + (size - 2 * pad) / 2;
  const cy = pad + (size - 2 * pad) / 2;
  const scale = (size - 2 * pad) / (2 * range);
  const px = (value: number) => cx + value * scale;
  const py = (value: number) => cy - value * scale;
  let body = "";
  for (let value = -range; value <= range; value += 1) {
    body += line(px(value), pad, px(value), size - pad);
    body += line(pad, py(value), size - pad, py(value));
  }
  body += `<polygon points="${size - pad},${cy} ${size - pad - 8},${cy - 4} ${size - pad - 8},${cy + 4}" fill="#000" stroke="none"/>`;
  body += `<polygon points="${cx},${pad} ${cx - 4},${pad + 8} ${cx + 4},${pad + 8}" fill="#000" stroke="none"/>`;
  body += text(size - pad - 12, cy + 16, "x") + text(cx + 8, pad + 12, "y");
  for (const point of Array.isArray(params.points) ? params.points : []) {
    if (Array.isArray(point) && point.length === 2) {
      const [x, y] = point as [number, number];
      body += `<circle cx="${px(x)}" cy="${py(y)}" r="3.5" fill="#000" stroke="none"/>`;
    }
  }
  return wrap(size, size, body, "Cartesian plane");
};
