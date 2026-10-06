/**
 * Colour parsing (spec 12.1). The domain parser accepts `#hex`, `rgb()` and `rgba()` only;
 * anything else is reported as unsupported rather than guessed.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const clampByte = (value: number): number => Math.min(255, Math.max(0, value));

export function parseColor(input: string): Rgba | undefined {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const byte = (i: number): number => Number.parseInt(digits.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = (fn[1] as string).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const channel = (part: string): number | undefined => {
      const value = part.endsWith("%")
        ? (Number.parseFloat(part) / 100) * 255
        : Number.parseFloat(part);
      return Number.isFinite(value) ? clampByte(value) : undefined;
    };
    const [r, g, b] = [
      channel(parts[0] as string),
      channel(parts[1] as string),
      channel(parts[2] as string),
    ];
    if (r === undefined || g === undefined || b === undefined) return undefined;
    let a = 1;
    if (parts[3] !== undefined) {
      const value = parts[3].endsWith("%")
        ? Number.parseFloat(parts[3]) / 100
        : Number.parseFloat(parts[3]);
      if (!Number.isFinite(value)) return undefined;
      a = Math.min(1, Math.max(0, value));
    }
    return { r, g, b, a };
  }
  return undefined;
}

const byteHex = (value: number): string =>
  Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** `#RRGGBB` (alpha is dropped: callers compose first). */
export const toHex = (color: Rgba): string =>
  `#${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`;

export const isOpaque = (color: Rgba): boolean => color.a >= 1;

/** `#RRGGBB` exactly, the format of palette catalogs and locked colours. */
export const isHex6 = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
