import { figureRoot, label, line, measureText, segment, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

const BODY =
  `<ellipse cx="110" cy="45" rx="60" ry="18"/>` +
  line(50, 45, 50, 150) +
  line(170, 45, 170, 150) +
  `<path d="M50 150 A60 18 0 0 0 170 150"/>`;

/**
 * A right circular cylinder. With `radius` and `height` (plus `unit`) it marks the radius on the
 * top face (or the diameter with `diameter: true`) and the height beside it.
 */
export const cylinder: FigureComponent = (params, title) => {
  if (params.radius === undefined && params.height === undefined) {
    return wrap(220, 190, BODY, "Cylinder");
  }
  const across = measureText(params.radius, params.unit);
  const tall = measureText(params.height, params.unit);
  const diameter = params.diameter === true;
  let body = `${BODY}<path d="M50 150 A60 18 0 0 1 170 150" fill="none" stroke-dasharray="4 3"/>`;
  body += diameter ? segment(50, 45, 170, 45, 'stroke-width="1.8"') : segment(110, 45, 170, 45);
  body += `<circle cx="110" cy="45" r="2.2" fill="#000" stroke="none"/>`;
  body += label(diameter ? 110 : 140, 38, across, { size: 12 });
  body += segment(185, 45, 185, 150) + segment(181, 45, 189, 45) + segment(181, 150, 189, 150);
  body += label(192, 102, tall, { size: 12, anchor: "start" });
  const name = title ?? `Cilindro de ${diameter ? "diámetro" : "radio"} ${across} y altura ${tall}`;
  return figureRoot(260, 190, body, name);
};
