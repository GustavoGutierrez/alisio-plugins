/**
 * Deterministic math figures (spec: figures). Each figure is generated as a self-contained SVG in
 * print-safe tones, so items can embed diagrams without any external asset or network access.
 *
 * Layout: `types.ts` (spec types), `style.ts` (shared tones), `svg.ts` (primitives),
 * `components/<kind>.ts` (one figure each), `registry.ts` (kind -> component), `render.ts`
 * (`figureSvg`). This file is only the public barrel.
 */

export { compositeVertices } from "./components/composite-rect.js";
export { type Curve, evaluateCurve } from "./components/function-plot.js";
export { figureKinds, figureRegistry } from "./registry.js";
export { figureSvg } from "./render.js";
export type { FigureComponent, FigureKind, FigureSpec } from "./types.js";
