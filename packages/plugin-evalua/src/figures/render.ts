import { figureRegistry } from "./registry.js";
import { pastelAt, pastelForSignature } from "./style.js";
import { esc, text, wrap } from "./svg.js";
import type { FigureSpec } from "./types.js";

/** Builds the SVG for a figure; unknown kinds fall back to a labelled placeholder. */
export function figureSvg(spec: FigureSpec, tone?: number): string {
  const params = spec.params ?? {};
  const component = Object.hasOwn(figureRegistry, spec.kind)
    ? figureRegistry[spec.kind]
    : undefined;
  const label = spec.label !== undefined && spec.label.trim() !== "" ? spec.label : undefined;
  let svg =
    component === undefined
      ? wrap(200, 60, text(10, 35, `figure: ${String(spec.kind)}`), spec.label)
      : component(params, label);
  if (label !== undefined) {
    svg = svg.replace(/aria-label="[^"]*"/, `aria-label="${esc(label)}"`);
  }
  // Every closed shape inherits the group fill; shapes that carry meaning with their own fill
  // (the Venn circles, the fraction bar) set it explicitly and win over this. A running `tone`
  // spreads the palette across one document, so a sheet of figures is not five times the same
  // colour; without one the spec picks its own, which keeps a lone figure stable.
  const signature = `${spec.kind}|${spec.label ?? ""}|${JSON.stringify(spec.params ?? {})}`;
  const fill = tone === undefined ? pastelForSignature(signature) : pastelAt(tone);
  return svg.replace('<g fill="none"', `<g fill="${fill}"`);
}
