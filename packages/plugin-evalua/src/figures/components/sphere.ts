import { dot, figureRoot, label, measureText, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

/**
 * A sphere (or a hemisphere with `half: true`) with its centre and a radius labelled with
 * `radius` and `unit`; `diameter: true` draws and labels the whole diameter instead.
 */
export const sphere: FigureComponent = (params, title) => {
  const cx = 120;
  const cy = 100;
  const r = 70;
  const half = params.half === true;
  const diameter = params.diameter === true;
  const text = measureText(params.radius, params.unit);
  let body = half
    ? `<path d="M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy} A${r} 18 0 0 1 ${cx - r} ${cy} Z"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  // The equator: front half solid, back half dashed, so the solid reads as round on paper.
  body += `<path d="M${cx - r} ${cy} A${r} 18 0 0 0 ${cx + r} ${cy}" fill="none"/>`;
  body += `<path d="M${cx - r} ${cy} A${r} 18 0 0 1 ${cx + r} ${cy}" fill="none" stroke-dasharray="4 3"/>`;
  body += dot(cx, cy, 2.5);
  if (diameter) {
    body += segment(cx - r, cy, cx + r, cy, 'stroke-width="1.8"');
    body += label(cx, cy - 26, text, { size: 13 });
  } else {
    body += segment(cx, cy, cx + r, cy, 'stroke-width="1.8"');
    body += label(cx + r / 2, cy - 26, text, { size: 13 });
  }
  const solid = half ? "Semiesfera" : "Esfera";
  const name = title ?? `${solid} de ${diameter ? "diámetro" : "radio"} ${text}`;
  return figureRoot(240, half ? 130 : 190, body, name);
};
