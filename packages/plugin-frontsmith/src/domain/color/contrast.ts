/**
 * Contrast math (spec 12.1): WCAG relative luminance and ratio with no rounding before comparison.
 * Parsing and composition live in `parse.ts` and `compose.ts`; the helpers are re-exported here so
 * callers that only need contrast keep one import.
 */
import { composeBackground, composite } from "./compose.js";
import { parseColor, type Rgba, toHex } from "./parse.js";

export type { Rgba };
export { composite, parseColor };

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** `(max + 0.05) / (min + 0.05)`; no rounding before comparison. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = foreground.a < 1 ? composite(foreground, background) : foreground;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export type ContrastKind = "normal_text" | "large_text" | "non_text";
export type ContrastTarget = "AA" | "AAA";

/** WCAG 2.2 minimum ratios for a target level. */
export function minimumRatio(kind: ContrastKind, target: ContrastTarget): number {
  if (kind === "non_text") return 3;
  if (target === "AAA") return kind === "large_text" ? 4.5 : 7;
  return kind === "large_text" ? 3 : 4.5;
}

/** Large text: 24 CSS px, or 18.6667 CSS px and bold; anything unknown is normal text. */
export function classifyText(
  fontSizePx: number | undefined,
  fontWeight: number | undefined,
): "large_text" | "normal_text" {
  if (fontSizePx === undefined || !Number.isFinite(fontSizePx)) return "normal_text";
  if (fontSizePx >= 24) return "large_text";
  return fontSizePx >= 18.6667 && (fontWeight ?? 0) >= 700 ? "large_text" : "normal_text";
}

export interface ContrastInput {
  fg: string;
  bg: string;
  kind: ContrastKind;
  target?: ContrastTarget;
  /** Product margin added to the WCAG minimum; reported as such, never as a WCAG threshold. */
  margin?: number;
  /**
   * Layers behind the foreground, bottom to top; `bg` is composed over them.
   * TODO(owner): spec 10.5 names `backgroundStack` without its order or its relation to `bg`.
   */
  backgroundStack?: readonly string[];
}

export interface ContrastResult {
  fg: string;
  bg: string;
  kind: ContrastKind;
  target: ContrastTarget;
  /** Foreground after composition over the background, `#RRGGBB`; `null` when not resolved. */
  compositedFg: string | null;
  /** Unrounded ratio; `null` when the colours could not be resolved. */
  ratio: number | null;
  minimum: number;
  status: "PASS" | "FAIL" | "REVIEW";
  reason?: string;
}

/** Evaluate one pair; unknown or unsupported inputs are REVIEW, never PASS (spec 12.1). */
export function evaluateContrast(input: ContrastInput): ContrastResult {
  const target = input.target ?? "AA";
  const minimum = minimumRatio(input.kind, target) + (input.margin ?? 0);
  const base = {
    fg: input.fg,
    bg: input.bg,
    kind: input.kind,
    target,
    compositedFg: null,
    ratio: null,
    minimum,
  } as const;
  const review = (reason: string): ContrastResult => ({ ...base, status: "REVIEW", reason });
  const foreground = parseColor(input.fg);
  if (!foreground) return review(`unsupported color format: ${input.fg}`);
  const layers = [...(input.backgroundStack ?? []), input.bg].map((value) => ({
    value,
    color: parseColor(value),
  }));
  const unsupported = layers.find((layer) => !layer.color);
  if (unsupported) return review(`unsupported color format: ${unsupported.value}`);
  const stack = composeBackground(layers.map((layer) => layer.color as Rgba));
  if (!stack.ok) return review(stack.reason);
  const composed = foreground.a < 1 ? composite(foreground, stack.color) : foreground;
  const ratio = contrastRatio(composed, stack.color);
  return {
    ...base,
    compositedFg: toHex(composed),
    ratio,
    status: ratio >= minimum ? "PASS" : "FAIL",
  };
}
