import { CardsmithError } from "./errors.js";

/** Bilingual label; product copy only, never used as an identifier. */
export interface LocalizedLabel {
  es: string;
  en: string;
}

export type PaletteTokenName =
  | "background"
  | "text"
  | "primary"
  | "secondary"
  | "accent"
  | "decorative";

export const PALETTE_TOKEN_NAMES: readonly PaletteTokenName[] = [
  "background",
  "text",
  "primary",
  "secondary",
  "accent",
  "decorative",
];

export interface PaletteTokens {
  background: string;
  text: string;
  primary: string;
  secondary: string;
  accent: string;
  /** Extra decorative colors; `$decorative` resolves to the first entry, falling back to accent. */
  decorative?: string[];
}

/**
 * Palette resource. `textOn` lists the approved text colors per surface token: only combinations
 * that pass the normal-text contrast target are approved, everything else is up to layout logic.
 */
export interface Palette {
  id: string;
  version: number;
  label: LocalizedLabel;
  colorblindNote?: LocalizedLabel;
  tokens: PaletteTokens;
  textOn: Record<string, string[]>;
}

/** WCAG target for normal text. */
export const CONTRAST_NORMAL_TEXT = 4.5;

/** WCAG target for large text (>= 24px, or >= 18.66px bold). */
export const CONTRAST_LARGE_TEXT = 3;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isPaletteTokenName(value: string): value is PaletteTokenName {
  return (PALETTE_TOKEN_NAMES as readonly string[]).includes(value);
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** WCAG relative luminance of a `#rrggbb` color, in [0, 1]. */
export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) {
    throw new CardsmithError("INVALID_SPEC", `Not a #rrggbb color: "${hex}"`, { color: hex });
  }
  const channels: number[] = [];
  for (let offset = 1; offset < 7; offset += 2) {
    const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    channels.push(byte <= 0.03928 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4);
  }
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio between two `#rrggbb` colors, in [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG "large text" rule at 24px; the bold 18.66px threshold is not modeled in v1. */
export function isLargeText(sizePx: number): boolean {
  return sizePx >= 24;
}

/** True when a pair reaches the target for the given text size (4.5:1 normal, 3:1 large). */
export function meetsContrast(hexA: string, hexB: string, sizePx: number): boolean {
  const target = isLargeText(sizePx) ? CONTRAST_LARGE_TEXT : CONTRAST_NORMAL_TEXT;
  return contrastRatio(hexA, hexB) >= target;
}

/** Resolve a palette token name to a concrete color; unknown names throw INVALID_SPEC. */
export function paletteToken(tokens: PaletteTokens, name: string): string {
  if (!isPaletteTokenName(name)) {
    throw new CardsmithError("INVALID_SPEC", `Unknown palette token "${name}"`, { token: name });
  }
  if (name === "decorative") {
    const first = tokens.decorative?.[0];
    return first ?? tokens.accent;
  }
  const value = tokens[name];
  if (typeof value !== "string") {
    throw new CardsmithError("INVALID_SPEC", `Palette token "${name}" is missing`, { token: name });
  }
  return value;
}

/**
 * Conservative palette validation: every approved `textOn` pair must reach 4.5:1, the normal-text
 * target. Decorative tokens are not text colors and stay exempt. The 3:1 large-text relaxation is
 * available through {@link meetsContrast} for layout-time decisions.
 */
export function validatePalette(palette: Palette): void {
  const required: PaletteTokenName[] = ["background", "text", "primary", "secondary", "accent"];
  for (const name of required) {
    const value = palette.tokens[name];
    if (typeof value !== "string" || !isHexColor(value)) {
      throw new CardsmithError("INVALID_SPEC", `Palette "${palette.id}" has no valid "${name}"`, {
        paletteId: palette.id,
        token: name,
      });
    }
  }
  for (const extra of palette.tokens.decorative ?? []) {
    if (!isHexColor(extra)) {
      throw new CardsmithError(
        "INVALID_SPEC",
        `Palette "${palette.id}" has an invalid decorative`,
        {
          paletteId: palette.id,
          color: extra,
        },
      );
    }
  }
  const background = palette.textOn.background;
  if (!Array.isArray(background) || !background.includes("text")) {
    throw new CardsmithError(
      "INVALID_SPEC",
      `Palette "${palette.id}" must approve "text" on "background"`,
      { paletteId: palette.id },
    );
  }
  for (const [surface, textTokens] of Object.entries(palette.textOn)) {
    const surfaceColor = paletteToken(palette.tokens, surface);
    for (const textToken of textTokens) {
      const textColor = paletteToken(palette.tokens, textToken);
      const ratio = contrastRatio(surfaceColor, textColor);
      if (ratio < CONTRAST_NORMAL_TEXT) {
        throw new CardsmithError(
          "INVALID_SPEC",
          `Palette "${palette.id}" approves "${textToken}" on "${surface}" at only ${ratio.toFixed(2)}:1`,
          { paletteId: palette.id, surface, token: textToken, ratio },
        );
      }
    }
  }
}
