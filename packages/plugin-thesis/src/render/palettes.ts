import { readFileSync } from "node:fs";
import { packagePath } from "../package-paths.js";

/**
 * Palettes shipped in `templates/palettes.json` (spec 10.5). Format neutral: charts and diagram
 * themes both derive their colors from here, so agents never set colors themselves.
 */

export interface Palette {
  name: string;
  kind: "categorical" | "sequential";
  colors: string[];
  /** Colors that must not be used for thin lines (for example yellow on white). */
  excludeForLines: string[];
  maxSeries?: number;
}

interface PaletteFile {
  palettes: Record<
    string,
    {
      kind: "categorical" | "sequential";
      colors: string[];
      excludeForLines?: string[];
      maxSeries?: number;
    }
  >;
}

let cached: PaletteFile | undefined;

export function loadPalette(name: string): Palette {
  cached ??= JSON.parse(
    readFileSync(packagePath("templates", "palettes.json"), "utf8"),
  ) as PaletteFile;
  const entry =
    cached.palettes[name] ?? (cached.palettes["okabe-ito"] as PaletteFile["palettes"][string]);
  return {
    name: cached.palettes[name] ? name : "okabe-ito",
    kind: entry.kind,
    colors: [...entry.colors],
    excludeForLines: entry.excludeForLines ?? [],
    ...(entry.maxSeries === undefined ? {} : { maxSeries: entry.maxSeries }),
  };
}

const hex = /^#([0-9a-f]{6})$/i;

export function parseHex(color: string): [number, number, number] {
  const match = hex.exec(color);
  if (!match) throw new Error(`Not a #rrggbb color: ${color}`);
  const value = Number.parseInt(match[1] as string, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix of `color` with white; `amount` 0 returns the color, 1 returns white. */
export function tint(color: string, amount: number): string {
  const rgb = parseHex(color);
  return toHex(rgb.map((part) => part + (255 - part) * amount) as [number, number, number]);
}

/** Relative luminance (WCAG) in 0..1. */
export function luminance(color: string): number {
  const [r, g, b] = parseHex(color).map((part) => {
    const unit = part / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The darkest palette color that is neither black nor pale: a stable accent for diagrams. */
export function accentColor(palette: Palette): string {
  const candidates = palette.colors
    .filter((color) => luminance(color) >= 0.05 && luminance(color) <= 0.6)
    .sort((a, b) => luminance(a) - luminance(b));
  return candidates[0] ?? "#444444";
}
