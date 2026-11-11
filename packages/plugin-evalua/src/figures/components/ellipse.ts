import { line, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** An ellipse with both axes drawn. */
export const ellipse: FigureComponent = () =>
  wrap(
    220,
    160,
    `<ellipse cx="110" cy="80" rx="80" ry="50"/>${line(30, 80, 190, 80)}${line(110, 30, 110, 130)}`,
    "Ellipse",
  );
