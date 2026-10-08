import type { ResolvedFont } from "./typography.js";

export interface RectOp {
  op: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  radius?: number;
  alpha?: number;
}

export interface PathOp {
  op: "path";
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  alpha?: number;
}

export interface ImageOp {
  op: "image";
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fit?: "cover" | "contain" | "stretch";
  round?: "none" | "circle";
  alpha?: number;
}

export interface TextCurve {
  cx: number;
  cy: number;
  radius: number;
  /** Degrees, 0 at 3 o'clock, growing clockwise. */
  startAngle: number;
  endAngle: number;
  side: "outside" | "inside";
}

/**
 * Text block. `x`/`y` is the anchor selected by `align`/`valign`: horizontal left/center/right of
 * the block, vertical top/middle/bottom. The renderer draws `lines` (never re-wraps) with
 * `lineHeight` line advance, honoring `align`/`valign` around the anchor.
 */
export interface TextOp {
  op: "text";
  text: string;
  x: number;
  y: number;
  font: ResolvedFont;
  sizePx: number;
  color: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  lineHeight: number;
  lines: string[];
  maxWidth: number;
  curve?: TextCurve;
  /** 0..1 opacity, applied like every other op alpha (watermark tiles use it). */
  alpha?: number;
}

/**
 * QR op. `matrix` is the raw module grid (true = dark); `boxSize` includes the mandatory
 * 4-module quiet zone on every side, so the renderer derives
 * `modulePx = boxSize / (matrix.length + 2 * QR_QUIET_ZONE_MODULES)`.
 */
export interface QrOp {
  op: "qr";
  matrix: boolean[][];
  x: number;
  y: number;
  boxSize: number;
  dark: string;
  light: string;
}

export interface GroupOp {
  op: "group";
  children: SceneOp[];
  translateX?: number;
  translateY?: number;
  alpha?: number;
  /**
   * Clockwise rotation in degrees. The pivot is (`rotateX`, `rotateY`) or, when omitted, the
   * canvas center (watermark tiles rotate around their own anchor).
   */
  rotateDeg?: number;
  /** X coordinate of the rotation pivot; defaults to half the scene width. */
  rotateX?: number;
  /** Y coordinate of the rotation pivot; defaults to half the scene height. */
  rotateY?: number;
}

/** Typed drawing operations only; no eval, HTML or JavaScript. */
export type SceneOp = RectOp | PathOp | ImageOp | TextOp | QrOp | GroupOp;

export interface Scene {
  width: number;
  height: number;
  background: string;
  ops: SceneOp[];
}

export type { ResolvedFont };
