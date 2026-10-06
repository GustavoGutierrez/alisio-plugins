import { parseColor } from "../color/parse.js";

/** `18px` or `18` -> 18; anything else (`normal`, `1.5em`) -> `undefined`. */
export function pxValue(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?)(?:px)?\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

const WEIGHTS: Record<string, number> = { normal: 400, bold: 700, lighter: 300, bolder: 700 };

export function weightValue(value: string | number): number | undefined {
  if (typeof value === "number") return value;
  const named = WEIGHTS[value.trim().toLowerCase()];
  if (named !== undefined) return named;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** First family of a font stack, lower-cased and unquoted. */
export function familyValue(value: string): string {
  return (value.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

const hex = (n: number): string => n.toString(16).padStart(2, "0").toUpperCase();

/**
 * A CSS colour as `#RRGGBB` or `#RRGGBBAA` (alpha omitted when opaque); `undefined` for a format
 * the domain parser does not read (it accepts hex, `rgb()` and `rgba()`; spec 12.1).
 */
export function canonicalColor(value: string): string | undefined {
  const parsed = parseColor(value);
  if (!parsed) return undefined;
  const { r, g, b, a } = parsed;
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(Math.round(a * 255)) : ""}`;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
