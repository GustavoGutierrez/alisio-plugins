import { figureRoot, label, line, measureText, num, segment, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A measured radius (a length from the problem) is scaled into the drawing; a larger value is
 * already a pixel size. */
function circleRadius(value: unknown): number {
  const raw = num(value, 10);
  if (raw <= 10) return 30 + raw * 3;
  return Math.max(30, Math.min(75, raw));
}

/**
 * A circle whose radius (`show: "radius"`) or diameter (`show: "diameter"`) is drawn and labelled
 * with `value` and `unit` (`?` when it is the unknown); `half: true` draws a semicircle.
 */
function measured(params: Record<string, unknown>, title?: string): string {
  const r = 70;
  const cx = 110;
  const cy = 95;
  const diameter = params.show === "diameter";
  const shown = measureText(params.value, params.unit);
  const half = params.half === true;
  let body = half
    ? `<path d="M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy} Z"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  body += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="#000" stroke="none"/>`;
  body += diameter
    ? segment(cx - r, cy, cx + r, cy, 'stroke-width="1.8"')
    : segment(cx, cy, cx + r, cy, 'stroke-width="1.8"');
  body += label(diameter ? cx : cx + r / 2, cy - 8, shown, { size: 13 });
  const shape = half ? "Semicírculo" : "Círculo";
  return figureRoot(
    220,
    half ? 115 : 190,
    body,
    title ?? `${shape} de ${diameter ? "diámetro" : "radio"} ${shown}`,
  );
}

/** A circle with its centre and a radius marked `r`; `show` labels a measured radius or diameter. */
export const circle: FigureComponent = (params, title) => {
  if (params.show === "radius" || params.show === "diameter") return measured(params, title);
  const r = circleRadius(params.radius);
  const body =
    `<circle cx="100" cy="90" r="${r}"/>` +
    line(100, 90, 100 + r, 90) +
    `<circle cx="100" cy="90" r="2.5" fill="#000" stroke="none"/>` +
    text(100 + r / 2 - 6, 84, "r");
  return wrap(200, 180, body, "Circle");
};
