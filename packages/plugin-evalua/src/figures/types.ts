/** Figure spec types shared by the registry, the components and the markup (spec: figures). */

export type FigureKind =
  | "number-line"
  | "cartesian"
  | "venn"
  | "triangle"
  | "square"
  | "rectangle"
  | "polygon"
  | "circle"
  | "ellipse"
  | "prism"
  | "cylinder"
  | "cone"
  | "fraction-bar"
  | "bar-chart"
  | "angle"
  | "clock"
  | "fraction-circle"
  | "pictogram"
  | "composite-rect"
  | "cube-stack"
  | "coordinate-grid"
  | "spinner"
  | "urn";

export interface FigureSpec {
  kind: FigureKind;
  /** Accessible label; also used as the figure caption when present. */
  label?: string;
  params?: Record<string, unknown>;
}

/**
 * One figure component: a pure function from the spec's params to a self-contained SVG string.
 * `label` is the spec's accessible label, so a component can also write it as the SVG `<title>`.
 * Components validate and clamp their own params; they never throw on bad input.
 */
export type FigureComponent = (params: Record<string, unknown>, label?: string) => string;
