/**
 * Low-level SVG primitives shared by every figure component: escaping, number formatting, the
 * root element (with accessible title), and line/text/arc/hatch helpers. No figure logic here.
 */

import { FONT_FAMILY, GRID, STROKE, STROKE_WIDTH } from "./style.js";

export const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** A finite number param, or the fallback. */
export const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** An integer param clamped to `[min, max]`. */
export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(num(value, fallback))));
}

/** A list of strings param (non-strings dropped). */
export const labels = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** A list of finite numbers param (non-numbers dropped). */
export const numbers = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];

/** `value unit`, `?` when the measure is the unknown. */
export function measureText(value: unknown, unit: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  const shown = String(Math.round(value * 100) / 100).replace(".", ",");
  return typeof unit === "string" && unit !== "" ? `${shown} ${unit}` : shown;
}

/** Coordinates with at most one decimal, trailing zeros trimmed (stable, compact output). */
export const fmt = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** The original root element: aria-label only. Kept byte-identical for the first figures. */
export function wrap(width: number, height: number, body: string, label?: string): string {
  const aria = label === undefined ? "" : ` aria-label="${esc(label)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"${aria} class="figure-svg"><g fill="none" stroke="${STROKE}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
}

/** The accessible root for new components: aria-label plus a `<title>` (and optional `<desc>`). */
export function figureRoot(
  width: number,
  height: number,
  body: string,
  title: string,
  desc?: string,
): string {
  const a11y = `<title>${esc(title)}</title>${desc === undefined ? "" : `<desc>${esc(desc)}</desc>`}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}" class="figure-svg">${a11y}<g fill="none" stroke="${STROKE}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
}

export const text = (x: number, y: number, value: string, size = 12): string =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="#000" stroke="none" font-family="${FONT_FAMILY}">${esc(value)}</text>`;

/** Text with an anchor (`start`, `middle`, `end`), coordinates formatted. */
export const label = (
  x: number,
  y: number,
  value: string,
  { size = 12, anchor = "middle" }: { size?: number; anchor?: "start" | "middle" | "end" } = {},
): string =>
  `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" text-anchor="${anchor}" fill="#000" stroke="none" font-family="${FONT_FAMILY}">${esc(value)}</text>`;

export const line = (x1: number, y1: number, x2: number, y2: number): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

/** A formatted line; `extra` adds attributes (e.g. a stroke width). */
export const segment = (x1: number, y1: number, x2: number, y2: number, extra = ""): string =>
  `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"${extra === "" ? "" : ` ${extra}`}/>`;

/** A thin gray helper line (grid). */
export const gridLine = (x1: number, y1: number, x2: number, y2: number): string =>
  segment(x1, y1, x2, y2, `stroke="${GRID}" stroke-width="0.6"`);

export const dot = (x: number, y: number, r = 3.5): string =>
  `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="#000" stroke="none"/>`;

export function polygonPoints(
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rotation = -Math.PI / 2,
): string {
  const points: string[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index * 2 * Math.PI) / sides;
    points.push(
      `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`,
    );
  }
  return points.join(" ");
}

/** A point at `degrees` (mathematical: 0 = east, counter-clockwise) on a circle, SVG y-down. */
export function polar(cx: number, cy: number, r: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy - r * Math.sin(radians)];
}

/** An arc path from `from` to `to` degrees (counter-clockwise, mathematical angles). */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${fmt(x1)} ${fmt(y1)} A${r} ${r} 0 ${large} 0 ${fmt(x2)} ${fmt(y2)}`;
}

/** A closed pie-sector path from `from` to `to` degrees. */
export function sectorPath(cx: number, cy: number, r: number, from: number, to: number): string {
  if (Math.abs(to - from) >= 360) {
    return `M${fmt(cx - r)} ${fmt(cy)} A${r} ${r} 0 1 0 ${fmt(cx + r)} ${fmt(cy)} A${r} ${r} 0 1 0 ${fmt(cx - r)} ${fmt(cy)} Z`;
  }
  return `M${fmt(cx)} ${fmt(cy)} L${arcPath(cx, cy, r, from, to).slice(1)} Z`;
}

/**
 * Diagonal hatch lines clipped to a rectangle: shading that survives monochrome printing, with no
 * `<pattern>` ids that could collide when many figures share one document.
 */
export function hatch(x: number, y: number, w: number, h: number, gap = 6): string {
  let out = "";
  for (let offset = gap; offset < w + h; offset += gap) {
    const x1 = x + Math.max(0, offset - h);
    const y1 = y + Math.min(h, offset);
    const x2 = x + Math.min(w, offset);
    const y2 = y + Math.max(0, offset - w);
    out += segment(x1, y1, x2, y2, 'stroke-width="0.8"');
  }
  return out;
}

/** Diagonal hatch for a pie sector, built from short chords along the sector's radii. */
export function hatchSector(
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
  gap = 6,
): string {
  let out = "";
  for (let distance = gap; distance < r; distance += gap) {
    const [ax, ay] = polar(cx, cy, distance, from + (to - from) * 0.08);
    const [bx, by] = polar(cx, cy, distance, to - (to - from) * 0.08);
    out += segment(ax, ay, bx, by, 'stroke-width="0.8"');
  }
  return out;
}
