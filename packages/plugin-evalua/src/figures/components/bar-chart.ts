import { figureRoot, fmt, gridLine, label, labels, line, num, numbers, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_BARS = 8;

/** The original unlabelled chart: bars scaled to the largest value, no axis numbers. */
function plain(values: readonly number[]): string {
  const width = 320;
  const height = 200;
  const left = 40;
  const base = 160;
  const max = Math.max(1, ...values);
  const slot = (width - left - 30) / Math.max(1, values.length);
  let body = line(left, base, width - 20, base) + line(left, 30, left, base);
  values.forEach((value, index) => {
    const barHeight = ((base - 30) * value) / max;
    const x = left + index * slot + slot * 0.2;
    const w = slot * 0.6;
    body += `<rect x="${x.toFixed(1)}" y="${(base - barHeight).toFixed(1)}" width="${w.toFixed(1)}" height="${barHeight.toFixed(1)}"/>`;
    body += `<rect x="${x.toFixed(1)}" y="${(base - barHeight).toFixed(1)}" width="${w.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="none"/>`;
  });
  return wrap(width, height, body, "Bar chart");
}

/**
 * A readable bar chart: one bar per category in `labels`, a numbered vertical axis every `step`
 * and light grid lines, so each bar's value can be read exactly from the drawing.
 */
function readable(
  values: readonly number[],
  names: readonly string[],
  params: Record<string, unknown>,
  title?: string,
): string {
  const count = Math.min(MAX_BARS, values.length);
  const step = Math.max(1, Math.round(num(params.step, 1)));
  const top = Math.max(step, Math.ceil(Math.max(1, ...values.slice(0, count)) / step) * step);
  const ticks = top / step;
  const width = 90 + count * 62;
  const height = 230;
  const left = 50;
  const base = 190;
  const plotTop = 24;
  const y = (value: number) => base - ((base - plotTop) * value) / top;
  let body = "";
  for (let tick = 0; tick <= ticks; tick += 1) {
    const value = tick * step;
    if (tick > 0) body += gridLine(left, y(value), width - 16, y(value));
    body += label(left - 6, y(value) + 4, String(value), { size: 11, anchor: "end" });
  }
  body += line(left, base, width - 16, base) + line(left, plotTop - 8, left, base);
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = Math.max(0, values[index] ?? 0);
    const name = names[index] ?? "";
    const x = left + 14 + index * 62;
    body += `<rect x="${fmt(x)}" y="${fmt(y(value))}" width="40" height="${fmt(base - y(value))}"/>`;
    body += label(x + 20, base + 16, name, { size: 11 });
    parts.push(`${name}: ${value}`);
  }
  const axis = typeof params.axis === "string" ? params.axis : undefined;
  if (axis !== undefined) body += label(left - 40, 14, axis, { size: 11, anchor: "start" });
  return figureRoot(width, height, body, title ?? "Gráfica de barras", parts.join("; "));
}

/** A bar chart: readable with axis numbers when `labels` are given, else the original drawing. */
export const barChart: FigureComponent = (params, title) => {
  const values = Array.isArray(params.values) ? numbers(params.values) : [3, 5, 2, 6];
  const names = labels(params.labels);
  if (names.length === 0) return plain(values);
  return readable(values, names, params, title);
};
