import { arcPath, figureRoot, label, num, polar, polygonPoints, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/**
 * A regular polygon with one interior angle marked and labelled `markAngle` (e.g. `x` or `?`), or
 * with `exterior: true` one side extended and its exterior angle marked instead.
 */
function marked(sides: number, params: Record<string, unknown>, title?: string): string {
  const cx = 120;
  const cy = 100;
  const r = 70;
  // Vertex k sits at `start - k·step` mathematical degrees; starting half a step right of the
  // bottom gives the polygon a horizontal bottom side, with the marked vertex at its right end.
  const step = 360 / sides;
  const start = -90 + step / 2;
  const vertex = (k: number) => polar(cx, cy, r, start - k * step);
  const [vx, vy] = vertex(0);
  const [px, py] = vertex(1);
  const [nx, ny] = vertex(-1);
  const toDeg = (x: number, y: number) => (Math.atan2(vy - y, x - vx) * 180) / Math.PI;
  const text = typeof params.markAngle === "string" ? params.markAngle : "?";
  let body = `<polygon points="${polygonPoints(cx, cy, r, sides, (-start * Math.PI) / 180)}"/>`;
  let from = toDeg(px, py);
  let to = toDeg(nx, ny);
  if (params.exterior === true) {
    const [ex, ey] = [vx + (vx - nx) * 0.6, vy + (vy - ny) * 0.6];
    body += `<line x1="${vx.toFixed(1)}" y1="${vy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"/>`;
    to = toDeg(ex, ey);
  }
  if ((to - from + 360) % 360 > 180) [from, to] = [to, from];
  if (to < from) to += 360;
  body += `<path d="${arcPath(vx, vy, 18, from, to)}" fill="none"/>`;
  const [lx, ly] = polar(vx, vy, 32, (from + to) / 2);
  body += label(lx, ly + 4, text, { size: 13 });
  const kind = params.exterior === true ? "exterior" : "interior";
  return figureRoot(
    250,
    200,
    body,
    title ?? `Polígono regular de ${sides} lados`,
    `Un ángulo ${kind} marcado con ${text}.`,
  );
}

/** A regular polygon of 3 to 12 `sides`; with `markAngle` one of its angles is marked. */
export const polygon: FigureComponent = (params, title) => {
  const sides = Math.max(3, Math.min(12, num(params.sides, 5)));
  if (params.markAngle !== undefined) return marked(Math.round(sides), params, title);
  return wrap(
    240,
    180,
    `<polygon points="${polygonPoints(120, 90, 70, sides)}"/>`,
    `Regular polygon (${sides} sides)`,
  );
};
