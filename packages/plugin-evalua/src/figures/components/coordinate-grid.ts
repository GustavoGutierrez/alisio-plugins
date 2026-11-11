import { figureRoot, gridLine, intParam, label, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

interface Point {
  x: number;
  y: number;
  name: string;
}

function points(value: unknown, min: number, max: number): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { x, y, name } = entry as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return [];
    if (x < min || x > max || y < min || y > max) return [];
    return [{ x, y, name: typeof name === "string" ? name : "" }];
  });
}

/**
 * A numbered coordinate grid: the first quadrant (`quadrants: 1`, 0 to `max`) or all four (-max to
 * max), with each point in `points` drawn as a dot named by its letter.
 */
export const coordinateGrid: FigureComponent = (params, title) => {
  const max = intParam(params.max, 6, 2, 12);
  const min = params.quadrants === 1 ? 0 : -max;
  const span = max - min;
  const cell = Math.min(24, Math.floor(260 / span));
  const pad = 30;
  const size = pad * 2 + span * cell;
  const px = (x: number) => pad + (x - min) * cell;
  const py = (y: number) => pad + (max - y) * cell;
  let body = "";
  for (let value = min; value <= max; value += 1) {
    body += gridLine(px(value), py(min), px(value), py(max));
    body += gridLine(px(min), py(value), px(max), py(value));
  }
  body +=
    segment(px(min), py(0), px(max) + 10, py(0)) + segment(px(0), py(min), px(0), py(max) - 10);
  body += label(px(max) + 14, py(0) + 4, "x", { anchor: "start" });
  body += label(px(0), py(max) - 14, "y");
  for (let value = min; value <= max; value += 1) {
    if (value === 0) continue;
    body += label(px(value), py(0) + 14, String(value), { size: 10 });
    body += label(px(0) - 5, py(value) + 4, String(value), { size: 10, anchor: "end" });
  }
  body += label(px(0) - 5, py(0) + 14, "0", { size: 10, anchor: "end" });
  const drawn = points(params.points, min, max);
  for (const point of drawn) {
    body += `<circle cx="${px(point.x)}" cy="${py(point.y)}" r="4" fill="#000" stroke="none"/>`;
    body += label(px(point.x) + 7, py(point.y) - 6, point.name, { size: 13, anchor: "start" });
  }
  const names = drawn.map((point) => point.name).filter(Boolean);
  return figureRoot(
    size + 10,
    size,
    body,
    title ?? "Plano cartesiano",
    names.length === 0 ? undefined : `Puntos marcados: ${names.join(", ")}.`,
  );
};
