import { wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A right circular cone. */
export const cone: FigureComponent = () => {
  // One closed silhouette (sides + front arc), so the pastel fill reads as a solid cone.
  const body = `<path d="M40 150 L110 30 L180 150 A70 20 0 0 1 40 150 Z"/>`;
  return wrap(220, 190, body, "Cone");
};
