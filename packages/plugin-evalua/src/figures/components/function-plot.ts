import { STROKE } from "../style.js";
import { dot, figureRoot, fmt, gridLine, label, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";
import { curves, evaluateCurve } from "./curves.js";

export { type Curve, evaluateCurve } from "./curves.js";

interface Mark {
  x: number;
  y: number;
  name: string;
}

function marks(value: unknown): Mark[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { x, y, name } = entry as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return [];
    return [{ x, y, name: typeof name === "string" ? name : "" }];
  });
}

const SAMPLES = 160;

/**
 * The graph of up to three functions on a numbered grid: window `xMin..xMax` by `yMin..yMax`, tick
 * labels every `xStep` / `yStep`, and named `points` drawn as dots. Curves stay inside the window.
 */
export const functionPlot: FigureComponent = (params, title) => {
  const xMin = Math.max(-50, Math.min(49, Math.round(num(params.xMin, -5))));
  const xMax = Math.max(xMin + 1, Math.min(50, Math.round(num(params.xMax, 5))));
  const yMin = Math.max(-500, Math.min(499, Math.round(num(params.yMin, -5))));
  const yMax = Math.max(yMin + 1, Math.min(500, Math.round(num(params.yMax, 5))));
  const xStep = Math.max(1, Math.round(num(params.xStep, 1)));
  const yStep = Math.max(1, Math.round(num(params.yStep, 1)));
  const width = 320;
  const height = 280;
  const pad = 30;
  const px = (x: number) => pad + ((x - xMin) / (xMax - xMin)) * (width - 2 * pad);
  const py = (y: number) => height - pad - ((y - yMin) / (yMax - yMin)) * (height - 2 * pad);
  let body = "";
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
    body += gridLine(px(x), py(yMin), px(x), py(yMax));
  }
  for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax; y += yStep) {
    body += gridLine(px(xMin), py(y), px(xMax), py(y));
  }
  const axisY = Math.min(yMax, Math.max(yMin, 0));
  const axisX = Math.min(xMax, Math.max(xMin, 0));
  body += segment(px(xMin), py(axisY), px(xMax) + 8, py(axisY));
  body += segment(px(axisX), py(yMin), px(axisX), py(yMax) - 8);
  body += label(px(xMax) + 12, py(axisY) + 4, "x", { anchor: "start" });
  body += label(px(axisX), py(yMax) - 12, "y");
  // The curves are sampled first, so a tick number they would run through can be left out.
  let curveBody = "";
  const traced: Array<[number, number]> = [];
  for (const curve of curves(params.curves)) {
    let path = "";
    let open = false;
    for (let index = 0; index <= SAMPLES; index += 1) {
      const x = xMin + ((xMax - xMin) * index) / SAMPLES;
      const y = evaluateCurve(curve, x);
      if (!Number.isFinite(y) || y < yMin || y > yMax) {
        open = false;
        continue;
      }
      path += `${open ? "L" : "M"}${fmt(px(x))} ${fmt(py(y))} `;
      open = true;
      // Four sub-samples per step keep steep stretches dense enough for the overlap test.
      for (let part = 0; part < 4; part += 1) {
        const sx = x + ((xMax - xMin) * part) / (4 * SAMPLES);
        const sy = evaluateCurve(curve, sx);
        if (Number.isFinite(sy)) traced.push([px(sx), py(sy)]);
      }
    }
    if (path !== "") {
      curveBody += `<path d="${path.trim()}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    }
  }
  // A tick number that would touch a point's name or be crossed by a curve is left out: the
  // neighbouring ticks still number the axis.
  const nameBoxes = marks(params.points)
    .filter(
      (mark) =>
        mark.name !== "" && mark.x >= xMin && mark.x <= xMax && mark.y >= yMin && mark.y <= yMax,
    )
    .map((mark) => {
      // The name starts 6 px right of the dot; the box keeps a small gap before it as well.
      const left = px(mark.x) + 1;
      return {
        left,
        right: left + mark.name.length * 8 + 7,
        top: py(mark.y) - 18,
        bottom: py(mark.y) - 2,
      };
    });
  const clear = (left: number, right: number, baseline: number): boolean =>
    nameBoxes.every(
      (box) =>
        right < box.left || left > box.right || baseline < box.top || baseline - 9 > box.bottom,
    ) &&
    traced.every(
      ([tx, ty]) => tx < left - 1 || tx > right + 1 || ty < baseline - 9 || ty > baseline + 2,
    );
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
    const half = String(x).length * 3;
    if (x !== axisX && clear(px(x) - half, px(x) + half, py(axisY) + 13)) {
      body += label(px(x), py(axisY) + 13, String(x), { size: 9 });
    }
  }
  for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax; y += yStep) {
    const width = String(y).length * 6;
    if (y !== axisY && clear(px(axisX) - 4 - width, px(axisX) - 4, py(y) + 3)) {
      body += label(px(axisX) - 4, py(y) + 3, String(y), { size: 9, anchor: "end" });
    }
  }
  body += curveBody;
  const drawn = marks(params.points).filter(
    (mark) => mark.x >= xMin && mark.x <= xMax && mark.y >= yMin && mark.y <= yMax,
  );
  for (const mark of drawn) {
    body += dot(px(mark.x), py(mark.y));
    if (mark.name !== "") {
      body += label(px(mark.x) + 6, py(mark.y) - 6, mark.name, { size: 11, anchor: "start" });
    }
  }
  const names = drawn.map((mark) => `${mark.name} (${mark.x}, ${mark.y})`.trim());
  return figureRoot(
    width,
    height,
    body,
    title ?? "Gráfica de una función",
    names.length === 0 ? undefined : `Puntos marcados: ${names.join("; ")}.`,
  );
};
