import { arcPath, figureRoot, label, line, num, polar, segment, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** The original generic angle marked α. */
function generic(): string {
  const body =
    line(40, 140, 220, 140) +
    line(40, 140, 190, 50) +
    `<path d="M90 140 A50 50 0 0 0 76 112" fill="none"/>` +
    text(96, 122, "α");
  return wrap(240, 170, body, "Angle");
}

/**
 * An angle of `degrees` (1 to 180) drawn to scale from a horizontal ray, with a right-angle box at
 * 90 and the measure written beside the arc when `showMeasure` is true.
 */
function measured(params: Record<string, unknown>, title?: string): string {
  const degrees = Math.max(1, Math.min(180, num(params.degrees, 45)));
  const cx = 130;
  const cy = 140;
  const ray = 110;
  const [ex, ey] = polar(cx, cy, ray, degrees);
  let body = segment(cx, cy, cx + ray, cy) + segment(cx, cy, ex, ey);
  if (degrees === 90) {
    body += `<path d="M${cx + 16} ${cy} L${cx + 16} ${cy - 16} L${cx} ${cy - 16}" fill="none"/>`;
  } else {
    body += `<path d="${arcPath(cx, cy, 28, 0, degrees)}" fill="none"/>`;
  }
  body += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="#000" stroke="none"/>`;
  if (params.showMeasure === true) {
    const [lx, ly] = polar(cx, cy, 46, degrees / 2);
    body += label(lx, ly + 4, `${degrees}°`, { size: 13 });
  }
  const name = title ?? (params.showMeasure === true ? `Ángulo de ${degrees} grados` : "Ángulo");
  return figureRoot(260, 160, body, name);
}

/** An angle: drawn to scale when `degrees` is given, else the original generic angle. */
export const angle: FigureComponent = (params, title) =>
  params.degrees === undefined ? generic() : measured(params, title);
