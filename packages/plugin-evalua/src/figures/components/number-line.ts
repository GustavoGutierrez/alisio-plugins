import { line, num, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** A horizontal number line from `min` to `max` with ticks every `step` and dotted `marks`. */
export const numberLine: FigureComponent = (params) => {
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
