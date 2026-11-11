import { figureRoot, label, measureText, segment, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

// One closed silhouette (sides + front arc), so the pastel fill reads as a solid cone.
const BODY = `<path d="M40 150 L110 30 L180 150 A70 20 0 0 1 40 150 Z"/>`;

/**
 * A right circular cone. With `radius` and `height` (plus `unit`) it draws the dashed height from
 * the apex and the radius (or the diameter with `diameter: true`) on the base, both labelled.
 */
export const cone: FigureComponent = (params, title) => {
  if (params.radius === undefined && params.height === undefined) {
    return wrap(220, 190, BODY, "Cone");
  }
  const across = measureText(params.radius, params.unit);
  const tall = measureText(params.height, params.unit);
  const diameter = params.diameter === true;
  let body = `${BODY}<path d="M40 150 A70 20 0 0 1 180 150" fill="none" stroke-dasharray="4 3"/>`;
  body += segment(110, 30, 110, 150, 'stroke-dasharray="4 3"');
  body += `<path d="M110 140 L120 140 L120 150" fill="none"/>`;
  body += diameter ? segment(40, 150, 180, 150, 'stroke-width="1.8"') : segment(110, 150, 180, 150);
  body += label(diameter ? 110 : 145, 186, across, { size: 12 });
  body += label(116, 100, tall, { size: 12, anchor: "start" });
  const name = title ?? `Cono de ${diameter ? "diámetro" : "radio"} ${across} y altura ${tall}`;
  return figureRoot(220, 190, body, name);
};
