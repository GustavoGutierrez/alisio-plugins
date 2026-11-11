import { figureRoot, fmt, label, line, num, segment, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";
import { intervalLine } from "./interval-line.js";

interface Named {
  value: number;
  name: string;
}

function named(value: unknown): Named[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return [];
    return [{ value: raw.value, name: typeof raw.name === "string" ? raw.name : "" }];
  });
}

/**
 * The labelled line: named `points` above the axis and, with `distances: true`, an arc from zero
 * to each point (its absolute value). `span: [a, b]` draws one arc between two values marked `?`.
 */
function labelled(params: Record<string, unknown>, title?: string): string {
  const min = Math.round(num(params.min, -10));
  const max = Math.max(min + 2, Math.round(num(params.max, 10)));
  const step = Math.max(1, Math.round(num(params.step, 1)));
  const width = 500;
  const left = 30;
  const right = width - 30;
  const axis = 90;
  const x = (value: number) => left + ((value - min) / (max - min)) * (right - left);
  const arc = (from: number, to: number, height: number, mark: string): string => {
    const [a, b] = [x(Math.min(from, to)), x(Math.max(from, to))];
    return (
      `<path d="M${fmt(a)} ${axis} Q${fmt((a + b) / 2)} ${axis - height} ${fmt(b)} ${axis}" fill="none" stroke-dasharray="4 3"/>` +
      label((a + b) / 2, axis - height / 2 - 4, mark, { size: 11 })
    );
  };
  let body = segment(left - 10, axis, right + 10, axis);
  body += `<polygon points="${right + 14},${axis} ${right + 6},${axis - 4} ${right + 6},${axis + 4}" fill="#000" stroke="none"/>`;
  body += `<polygon points="${left - 14},${axis} ${left - 6},${axis - 4} ${left - 6},${axis + 4}" fill="#000" stroke="none"/>`;
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    body += segment(x(value), axis - 5, x(value), axis + 5);
    body += label(x(value), axis + 20, String(value), { size: 10 });
  }
  const points = named(params.points).filter((point) => point.value >= min && point.value <= max);
  for (const point of points) {
    if (params.distances === true && point.value !== 0) {
      body += arc(0, point.value, 50, String(Math.abs(point.value)));
    }
    body += `<circle cx="${fmt(x(point.value))}" cy="${axis}" r="4.5" fill="#000" stroke="none"/>`;
    body += label(x(point.value), axis - 10, point.name, { size: 13 });
  }
  const span = Array.isArray(params.span) ? params.span : [];
  if (typeof span[0] === "number" && typeof span[1] === "number") {
    body += arc(span[0], span[1], 60, "?");
  }
  const names = points.map((point) => `${point.name} = ${point.value}`.trim());
  return figureRoot(
    width,
    120,
    body,
    title ?? "Recta numérica",
    names.length === 0 ? undefined : `Puntos: ${names.join(", ")}.`,
  );
}

/**
 * A horizontal number line from `min` to `max` with ticks every `step` and dotted `marks`; with
 * named `points` (objects `{ value, name }`) it is the labelled line drawn by `labelled`; with
 * `intervals` it is the shaded interval line of `interval-line.ts`.
 */
export const numberLine: FigureComponent = (params, title) => {
  if (Array.isArray(params.intervals)) return intervalLine(params, title);
  if (Array.isArray(params.points)) return labelled(params, title);
  const min = num(params.min, -5);
  const max = num(params.max, 5);
  const step = Math.max(1, num(params.step, 1));
  const width = 460;
  const height = 70;
  const left = 30;
  const right = width - 30;
  const span = max - min || 1;
  const x = (value: number) => left + ((value - min) / span) * (right - left);
  let body = `${line(left, 45, right, 45)}<polygon points="${right},45 ${right - 8},41 ${right - 8},49" fill="#000" stroke="none"/>`;
  for (let value = min; value <= max; value += step) {
    body += `${line(x(value), 40, x(value), 50)}${text(x(value) - 4, 64, String(value), 11)}`;
  }
  for (const mark of Array.isArray(params.marks) ? params.marks : []) {
    if (typeof mark === "number") {
      body += `<circle cx="${x(mark)}" cy="45" r="4" fill="#000" stroke="none"/>`;
    }
  }
  return wrap(width, height, body, "Number line");
};
