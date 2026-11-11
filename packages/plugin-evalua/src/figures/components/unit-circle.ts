import { arcPath, dot, figureRoot, fmt, label, num, polar, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

const SIZE = 280;
const CENTER = SIZE / 2;
const RADIUS = 92;

/** `start` / `middle` / `end` so a label sits on the outer side of a direction (degrees). */
function anchorFor(degrees: number): "start" | "middle" | "end" {
  const cos = Math.cos((degrees * Math.PI) / 180);
  if (cos > 0.3) return "start";
  if (cos < -0.3) return "end";
  return "middle";
}

/**
 * The unit circle on its axes, with the angle `angle` (degrees, counter-clockwise from the positive
 * x semi-axis) drawn as an arc labelled `angleLabel` and its terminal point named `point` (default
 * `P`). `projections: true` adds the dashed perpendiculars from the point to both axes.
 */
export const unitCircle: FigureComponent = (params, title) => {
  const raw = num(params.angle, 30);
  const angle = ((raw % 360) + 360) % 360;
  const angleText = typeof params.angleLabel === "string" ? params.angleLabel : `${raw}°`;
  const pointName = typeof params.point === "string" ? params.point : "P";
  const reach = RADIUS + 26;
  let body = `<circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}"/>`;
  body += segment(CENTER - reach, CENTER, CENTER + reach, CENTER);
  body += segment(CENTER, CENTER + reach, CENTER, CENTER - reach);
  body += label(CENTER + reach + 6, CENTER + 4, "x", { anchor: "start" });
  body += label(CENTER, CENTER - reach - 6, "y");
  // Tick labels at the four axis crossings, set back from the curve and the axes.
  body += label(CENTER + RADIUS + 4, CENTER + 15, "1", { size: 11, anchor: "start" });
  body += label(CENTER - RADIUS - 4, CENTER + 15, "-1", { size: 11, anchor: "end" });
  body += label(CENTER + 6, CENTER - RADIUS - 5, "1", { size: 11, anchor: "start" });
  body += label(CENTER + 6, CENTER + RADIUS + 15, "-1", { size: 11, anchor: "start" });
  const [px, py] = polar(CENTER, CENTER, RADIUS, angle);
  if (params.projections === true) {
    const dashed = 'stroke-dasharray="4 3" stroke-width="1"';
    body += segment(px, py, px, CENTER, dashed) + segment(px, py, CENTER, py, dashed);
  }
  body += segment(CENTER, CENTER, px, py, 'stroke-width="1.8"');
  if (angle > 0) {
    body += `<path d="${arcPath(CENTER, CENTER, 26, 0, angle)}" fill="none"/>`;
    // The arc label goes on the arc's bisector, outside the small arc.
    // Never centred: a centred label on a near-vertical bisector would sit on the y axis.
    const middle = angle / 2;
    const [lx, ly] = polar(CENTER, CENTER, 40, middle);
    const right = Math.cos((middle * Math.PI) / 180) >= 0;
    body += label(lx + (right ? 3 : -3), ly + 4, angleText, {
      size: 12,
      anchor: right ? "start" : "end",
    });
  }
  body += dot(px, py);
  const [nx, ny] = polar(CENTER, CENTER, RADIUS + 12, angle);
  body += label(nx, ny + 5, pointName, { size: 13, anchor: anchorFor(angle) });
  body += `<circle cx="${CENTER}" cy="${CENTER}" r="2" fill="#000" stroke="none"/>`;
  return figureRoot(
    SIZE,
    SIZE,
    body,
    title ?? "Circunferencia unitaria",
    `Ángulo de ${fmt(raw)}° (${angleText}) medido desde el semieje x positivo; su lado terminal corta la circunferencia unitaria en ${pointName}.`,
  );
};
