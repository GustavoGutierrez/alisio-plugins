import { figureRoot, fmt, label, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** `3.5` -> `3,5`, the decimal comma readers expect. */
const shown = (value: number): string => fmt(value).replace(".", ",");

/**
 * A horizontal box plot over a numbered axis: whiskers from `min` to `max`, the box from `q1` to
 * `q3` and the `median` line inside it. The axis runs `axisMin..axisMax` with a tick every `step`,
 * so each of the five numbers can be read from the drawing.
 */
export const boxPlot: FigureComponent = (params, title) => {
  const values = [params.min, params.q1, params.median, params.q3, params.max].map((value, i) =>
    num(value, i * 2),
  );
  const [min, q1, mid, q3, max] = [...values].sort((a, b) => a - b) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const step = Math.max(1, Math.round(num(params.step, 1)));
  const axisMin = Math.floor(Math.min(num(params.axisMin, min), min) / step) * step;
  const rawMax = Math.max(num(params.axisMax, max), max, axisMin + step);
  const axisMax = Math.ceil(rawMax / step) * step;
  const ticks = Math.min(40, Math.round((axisMax - axisMin) / step));
  const width = 380;
  const left = 30;
  const right = width - 30;
  const x = (value: number) => left + ((value - axisMin) / (axisMax - axisMin)) * (right - left);
  const top = params.showValues === true ? 52 : 40;
  const axis = top + 80;
  const bottom = top + 50;
  const middle = (top + bottom) / 2;
  let body = segment(left, axis, right, axis);
  for (let tick = 0; tick <= ticks; tick += 1) {
    const value = axisMin + tick * step;
    body += segment(x(value), axis - 4, x(value), axis + 4);
    body += label(x(value), axis + 18, shown(value), { size: 10 });
  }
  body += segment(x(min), middle, x(q1), middle) + segment(x(q3), middle, x(max), middle);
  body += segment(x(min), middle - 10, x(min), middle + 10);
  body += segment(x(max), middle - 10, x(max), middle + 10);
  body += `<rect x="${fmt(x(q1))}" y="${top}" width="${fmt(x(q3) - x(q1))}" height="${bottom - top}"/>`;
  body += segment(x(mid), top, x(mid), bottom, 'stroke-width="2.4"');
  if (params.showValues === true) {
    // Each of the five numbers written above its mark, staggered so close values never overlap.
    [min, q1, mid, q3, max].forEach((value, position) => {
      body += label(x(value), position % 2 === 0 ? top - 8 : top - 22, shown(value), { size: 11 });
    });
  }
  const axisName = typeof params.axis === "string" ? params.axis : undefined;
  if (axisName !== undefined) body += label(left, 20, axisName, { size: 11, anchor: "start" });
  return figureRoot(
    width,
    axis + 30,
    body,
    title ?? "Diagrama de caja",
    `Mínimo ${shown(min)}, primer cuartil ${shown(q1)}, mediana ${shown(mid)}, tercer cuartil ${shown(q3)}, máximo ${shown(max)}.`,
  );
};
