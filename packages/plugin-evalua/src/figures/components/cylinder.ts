import { line, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A right circular cylinder. */
export const cylinder: FigureComponent = () => {
  const body =
    `<ellipse cx="110" cy="45" rx="60" ry="18"/>` +
    line(50, 45, 50, 150) +
    line(170, 45, 170, 150) +
    `<path d="M50 150 A60 18 0 0 0 170 150"/>`;
  return wrap(220, 190, body, "Cylinder");
};
