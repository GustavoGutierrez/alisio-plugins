import { formatPathNumber } from "../core/assets.js";
import { type Palette, paletteToken } from "../core/palettes.js";

/** One chart value; `null` marks a missing point (line break, skipped bar or slice). */
export type ChartValue = number | null;

/** Series payload carried by `content.series`: an optional label plus finite values or nulls. */
export interface ChartSeriesData {
  label?: string;
  values: ChartValue[];
}

/** Series color cycle, repeated when a chart has more series than palette tokens. */
export const CHART_COLOR_TOKENS = ["primary", "secondary", "accent", "decorative"] as const;

/** Resolve the palette color of series/slice `index` through the shared cycle. */
export function seriesColor(palette: Palette, index: number): string {
  const token = CHART_COLOR_TOKENS[index % CHART_COLOR_TOKENS.length] ?? "primary";
  return paletteToken(palette.tokens, token);
}

/** Round `raw` up to the next 1/2/2.5/5/10 power-of-ten step. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** Axis domain with the tick values that are drawn as gridlines and labels. */
export interface AxisDomain {
  min: number;
  max: number;
  ticks: number[];
}

function cleanNumber(value: number): number {
  const clean = Number(value.toFixed(6));
  return Object.is(clean, -0) ? 0 : clean;
}

/**
 * Padded nice domain around the data range. `includeZero` forces the magnitude axis to cover
 * zero (bars); without it the range is the data's own min..max, including zero only when the
 * data crosses it. Equal values are padded by 10% (±1 around zero) so the axis stays visible.
 * An all-zero bar range returns the degenerate `{ min: 0, max: 0, ticks: [0] }`: baseline only.
 */
export function niceDomain(
  dataMin: number,
  dataMax: number,
  options: { includeZero: boolean },
): AxisDomain {
  let lo = dataMin;
  let hi = dataMax;
  if (options.includeZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    if (options.includeZero) return { min: lo, max: lo, ticks: [lo] };
    const pad = Math.abs(lo) === 0 ? 1 : Math.abs(lo) * 0.1;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / 4);
  const min = cleanNumber(Math.floor(lo / step) * step);
  const max = cleanNumber(Math.ceil(hi / step) * step);
  const count = Math.round((max - min) / step);
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(cleanNumber(min + index * step));
  }
  return { min, max, ticks };
}

/** Deterministic tick/total label: integers plain, decimals trimmed to two places. */
export function formatTickValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const clean = cleanNumber(value);
  if (Number.isInteger(clean)) return String(clean);
  return String(Number(clean.toFixed(2)));
}

/** Linear value -> y mapping. A degenerate domain pins every value to `bottom`. */
export function mapValueToY(
  value: number,
  domain: AxisDomain,
  top: number,
  bottom: number,
): number {
  const span = domain.max - domain.min;
  if (!(span > 0)) return bottom;
  return bottom - ((value - domain.min) / span) * (bottom - top);
}

export interface Point {
  x: number;
  y: number;
}

/** Open SVG polyline through `points`, formatted deterministically like asset paths. */
export function polylinePath(points: readonly Point[]): string {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${formatPathNumber(point.x)} ${formatPathNumber(point.y)}`,
    )
    .join(" ");
}

/**
 * SVG arc from `startDeg` to `endDeg` (degrees, 0 at 3 o'clock, growing clockwise in the y-down
 * canvas). Used for donut segments with a butt cap: the stroke is drawn at `radius`.
 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): string {
  const start = {
    x: cx + radius * Math.cos((startDeg * Math.PI) / 180),
    y: cy + radius * Math.sin((startDeg * Math.PI) / 180),
  };
  const end = {
    x: cx + radius * Math.cos((endDeg * Math.PI) / 180),
    y: cy + radius * Math.sin((endDeg * Math.PI) / 180),
  };
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${formatPathNumber(start.x)} ${formatPathNumber(start.y)}`,
    `A ${formatPathNumber(radius)} ${formatPathNumber(radius)} 0 ${largeArc} 1 ${formatPathNumber(end.x)} ${formatPathNumber(end.y)}`,
  ].join(" ");
}
