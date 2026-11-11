import { text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A labelled triangle ABC in one of four shapes (`equilateral`, `right`, `isosceles`, `scalene`). */
export const triangle: FigureComponent = (params) => {
  const variant = typeof params.variant === "string" ? params.variant : "equilateral";
  const width = 260;
  const height = 190;
  const a = [30, 160];
  let b = [230, 160];
  let c = [130, 40];
  if (variant === "right") c = [30, 40];
  if (variant === "isosceles") c = [130, 50];
  if (variant === "scalene") b = [210, 160];
  const body =
    `<polygon points="${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]}"/>` +
    text((a[0] ?? 0) - 14, (a[1] ?? 0) + 16, "A") +
    text((b[0] ?? 0) + 6, (b[1] ?? 0) + 16, "B") +
    text((c[0] ?? 0) - 4, (c[1] ?? 0) - 8, "C") +
    text(((a[0] ?? 0) + (c[0] ?? 0)) / 2 - 12, ((a[1] ?? 0) + (c[1] ?? 0)) / 2, "b") +
    text(((b[0] ?? 0) + (c[0] ?? 0)) / 2 + 6, ((b[1] ?? 0) + (c[1] ?? 0)) / 2, "a") +
    text(((a[0] ?? 0) + (b[0] ?? 0)) / 2 - 4, (a[1] ?? 0) + 16, "c");
  return wrap(width, height, body, "Triangle");
};
