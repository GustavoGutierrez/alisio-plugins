import { figureRoot, label, num, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

const BODY =
  `<polygon points="40,150 160,150 200,120 80,120"/>` +
  `<polygon points="40,150 40,70 160,70 160,150"/>` +
  `<polygon points="160,70 200,40 200,120 160,150"/>` +
  `<polygon points="40,70 80,40 200,40 160,70"/>`;

/**
 * A rectangular prism. With `length`, `width` and `height` params its edges carry those measures
 * (plus an optional `unit`); without them it is the original unlabelled drawing.
 */
export const prism: FigureComponent = (params, title) => {
  const dims = [params.length, params.width, params.height];
  if (dims.every((value) => value === undefined)) return wrap(240, 190, BODY, "Rectangular prism");
  const unit = typeof params.unit === "string" ? ` ${params.unit}` : "";
  const show = (value: unknown) => (value === undefined ? "?" : `${num(value, 0)}${unit}`);
  const body =
    BODY +
    label(100, 168, show(params.length)) +
    label(34, 114, show(params.height), { anchor: "end" }) +
    label(186, 150, show(params.width), { anchor: "start" });
  const name =
    title ??
    `Prisma rectangular de ${show(params.length)} por ${show(params.width)} por ${show(params.height)}`;
  return figureRoot(250, 190, body, name);
};
