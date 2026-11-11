import { num, polygonPoints, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A regular polygon of 3 to 12 `sides`. */
export const polygon: FigureComponent = (params) => {
  const sides = Math.max(3, Math.min(12, num(params.sides, 5)));
  return wrap(
    240,
    180,
    `<polygon points="${polygonPoints(120, 90, 70, sides)}"/>`,
    `Regular polygon (${sides} sides)`,
  );
};
