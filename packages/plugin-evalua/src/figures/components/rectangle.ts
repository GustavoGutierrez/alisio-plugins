import { text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A rectangle ABCD with its vertices named. */
export const rectangle: FigureComponent = () =>
  wrap(
    240,
    180,
    `<rect x="40" y="55" width="160" height="90"/>` +
      text(32, 162, "A") +
      text(208, 162, "B") +
      text(208, 48, "C") +
      text(32, 48, "D"),
    "Rectangle",
  );
