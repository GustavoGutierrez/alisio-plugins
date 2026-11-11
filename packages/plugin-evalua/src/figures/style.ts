/** Shared print-safe style: black strokes, one serif face, and the light pastel fills. */

export const STROKE = "#000";
export const STROKE_WIDTH = 1.4;
export const FONT_FAMILY = "serif";
/** The plain paper tone for faces that must read as empty (unshaded parts, backgrounds). */
export const PAPER = "#ffffff";
/** A mid gray for helper lines (grids); prints as a light line on any printer. */
export const GRID = "#9a9a9a";

/** Soft fills for the figure faces. Print-safe: every one of them reads as a light tone on paper. */
export const PASTELS = ["#FFDA64", "#A3D084", "#F4B281", "#E3E3E3", "#8FA9DA"] as const;

/** FNV-1a over a signature string, so the same spec always draws in the same colour. */
export function pastelForSignature(signature: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PASTELS[hash % PASTELS.length] ?? PASTELS[0];
}

/** The palette slot for a running index, wrapping in both directions. */
export function pastelAt(tone: number): string {
  const index = (((Math.trunc(tone) % PASTELS.length) + PASTELS.length) % PASTELS.length) | 0;
  return PASTELS[index] ?? PASTELS[0];
}
