import { angle } from "./components/angle.js";
import { barChart } from "./components/bar-chart.js";
import { cartesian } from "./components/cartesian.js";
import { circle } from "./components/circle.js";
import { clock } from "./components/clock.js";
import { compositeRect } from "./components/composite-rect.js";
import { cone } from "./components/cone.js";
import { coordinateGrid } from "./components/coordinate-grid.js";
import { cubeStack } from "./components/cube-stack.js";
import { cylinder } from "./components/cylinder.js";
import { ellipse } from "./components/ellipse.js";
import { fractionBar } from "./components/fraction-bar.js";
import { fractionCircle } from "./components/fraction-circle.js";
import { numberLine } from "./components/number-line.js";
import { pictogram } from "./components/pictogram.js";
import { polygon } from "./components/polygon.js";
import { prism } from "./components/prism.js";
import { rectangle } from "./components/rectangle.js";
import { spinner } from "./components/spinner.js";
import { square } from "./components/square.js";
import { triangle } from "./components/triangle.js";
import { urn } from "./components/urn.js";
import { venn } from "./components/venn.js";
import type { FigureComponent, FigureKind } from "./types.js";

/** Figure kind -> component. Adding a figure is one component file plus one line here. */
export const figureRegistry: Readonly<Record<FigureKind, FigureComponent>> = {
  "number-line": numberLine,
  cartesian,
  venn,
  triangle,
  square,
  rectangle,
  polygon,
  circle,
  ellipse,
  prism,
  cylinder,
  cone,
  "fraction-bar": fractionBar,
  "bar-chart": barChart,
  angle,
  clock,
  "fraction-circle": fractionCircle,
  pictogram,
  "composite-rect": compositeRect,
  "cube-stack": cubeStack,
  "coordinate-grid": coordinateGrid,
  spinner,
  urn,
};

/** Every registered kind, in registry order. */
export const figureKinds: readonly FigureKind[] = Object.keys(figureRegistry) as FigureKind[];
