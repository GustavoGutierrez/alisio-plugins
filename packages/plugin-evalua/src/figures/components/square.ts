import { text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A square ABCD with its vertices named. */
export const square: FigureComponent = () =>
  wrap(
    240,
    180,
    `<rect x="60" y="35" width="120" height="120"/>` +
      text(52, 172, "A") +
      text(188, 172, "B") +
      text(188, 28, "C") +
      text(52, 28, "D"),
    "Square",
  );
