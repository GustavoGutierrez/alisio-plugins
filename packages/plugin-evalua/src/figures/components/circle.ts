import { line, num, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A measured radius (a length from the problem) is scaled into the drawing; a larger value is
 * already a pixel size. */
function circleRadius(value: unknown): number {
  const raw = num(value, 10);
  if (raw <= 10) return 30 + raw * 3;
  return Math.max(30, Math.min(75, raw));
}

/** A circle with its centre and a radius marked `r`. */
export const circle: FigureComponent = (params) => {
  const r = circleRadius(params.radius);
  const body =
    `<circle cx="100" cy="90" r="${r}"/>` +
    line(100, 90, 100 + r, 90) +
    `<circle cx="100" cy="90" r="2.5" fill="#000" stroke="none"/>` +
    text(100 + r / 2 - 6, 84, "r");
  return wrap(200, 180, body, "Circle");
};
