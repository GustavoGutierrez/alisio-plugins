import type { FigureSpec } from "../../src/figures/index.js";

/**
 * Figure specs whose SVG output predates the component refactor. Their frozen output lives in
 * `test/fixtures/figures-legacy.json`; the refactor (and every later change) must keep it
 * byte-identical, so a shipped exam never changes its drawings silently.
 */
export const LEGACY_CASES: ReadonlyArray<{ name: string; spec: FigureSpec; tone?: number }> = [
  { name: "number-line default", spec: { kind: "number-line" } },
  {
    name: "number-line marks",
    spec: { kind: "number-line", params: { min: -3, max: 4, marks: [1, -2] } },
  },
  { name: "cartesian default", spec: { kind: "cartesian" } },
  {
    name: "cartesian points",
    spec: {
      kind: "cartesian",
      params: {
        range: 4,
        points: [
          [1, 2],
          [-3, 0],
        ],
      },
    },
  },
  { name: "venn two", spec: { kind: "venn", params: { sets: 2, labels: ["A: pares"] } } },
  { name: "venn three", spec: { kind: "venn", params: { sets: 3 } } },
  {
    name: "triangle equilateral",
    spec: { kind: "triangle", label: "Triángulo equilátero", params: { variant: "equilateral" } },
  },
  { name: "triangle right", spec: { kind: "triangle", params: { variant: "right" } } },
  { name: "triangle isosceles", spec: { kind: "triangle", params: { variant: "isosceles" } } },
  { name: "triangle scalene", spec: { kind: "triangle", params: { variant: "scalene" } } },
  { name: "square", spec: { kind: "square", label: "Cuadrado" } },
  { name: "rectangle", spec: { kind: "rectangle", label: "Rectángulo" } },
  {
    name: "polygon six",
    spec: { kind: "polygon", params: { sides: 6 }, label: "Polígono de 6 lados" },
  },
  { name: "polygon default", spec: { kind: "polygon" } },
  { name: "circle small", spec: { kind: "circle", params: { radius: 4 } } },
  { name: "circle pixels", spec: { kind: "circle", params: { radius: 60 } } },
  { name: "ellipse", spec: { kind: "ellipse" } },
  { name: "prism", spec: { kind: "prism" } },
  { name: "cylinder", spec: { kind: "cylinder" } },
  { name: "cone", spec: { kind: "cone" } },
  { name: "fraction-bar", spec: { kind: "fraction-bar", params: { parts: 5, shaded: 3 } } },
  { name: "bar-chart default", spec: { kind: "bar-chart" } },
  { name: "bar-chart values", spec: { kind: "bar-chart", params: { values: [4, 1, 7] } } },
  { name: "angle", spec: { kind: "angle" } },
  { name: "unknown", spec: { kind: "nope" as never, label: "custom" } },
  { name: "escaped label", spec: { kind: "square", label: "A < B & C" } },
  { name: "toned square", spec: { kind: "square" }, tone: 2 },
];
