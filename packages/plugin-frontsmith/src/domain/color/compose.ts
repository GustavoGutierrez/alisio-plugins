import { isOpaque, type Rgba } from "./parse.js";

/** Source-over composition in 8-bit sRGB, rounded per channel after composition (spec 12.1). */
export function composite(foreground: Rgba, background: Rgba): Rgba {
  const mix = (f: number, b: number): number =>
    Math.round(foreground.a * f + (1 - foreground.a) * b);
  return {
    r: mix(foreground.r, background.r),
    g: mix(foreground.g, background.g),
    b: mix(foreground.b, background.b),
    a: 1,
  };
}

export type StackResult = { ok: true; color: Rgba } | { ok: false; reason: string };

/**
 * Resolve layers bottom-up: the first layer must be opaque, each next layer is composed over the
 * result so far. An empty stack or a translucent base has no known background.
 */
export function composeBackground(layers: readonly Rgba[]): StackResult {
  const [base, ...rest] = layers;
  if (!base) return { ok: false, reason: "background stack is empty" };
  if (!isOpaque(base)) return { ok: false, reason: "background is not opaque" };
  let result = base;
  for (const layer of rest) result = isOpaque(layer) ? layer : composite(layer, result);
  return { ok: true, color: result };
}
