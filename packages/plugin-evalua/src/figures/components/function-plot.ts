import { STROKE } from "../style.js";
import { dot, figureRoot, fmt, gridLine, label, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

/**
 * One curve, evaluated by the component from exact parameters, so a family draws the very function
 * it asks about. `polynomial` takes ascending coefficients (`[c, b, a]` is `a x² + b x + c`),
 * `exponential` is `a · base^x`, `logarithm` is `log_base(x)`. Later topics add kinds here.
 */
export type Curve =
  | { type: "polynomial"; coefficients: number[] }
  | { type: "exponential"; a: number; base: number }
  | { type: "logarithm"; base: number };

export function evaluateCurve(curve: Curve, x: number): number {
  switch (curve.type) {
    case "polynomial":
      return curve.coefficients.reduceRight((total, coefficient) => total * x + coefficient, 0);
    case "exponential":
      return curve.a * curve.base ** x;
    case "logarithm":
      return x > 0 && curve.base > 0 && curve.base !== 1 ? Math.log(x) / Math.log(curve.base) : NaN;
  }
}

function curves(value: unknown): Curve[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry): Curve[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (raw.type === "polynomial" && Array.isArray(raw.coefficients)) {
      const coefficients = raw.coefficients.filter(
        (c): c is number => typeof c === "number" && Number.isFinite(c),
      );
      return coefficients.length === 0 ? [] : [{ type: "polynomial", coefficients }];
    }
    if (raw.type === "exponential") {
      return [{ type: "exponential", a: num(raw.a, 1), base: Math.max(0.01, num(raw.base, 2)) }];
    }
    if (raw.type === "logarithm") return [{ type: "logarithm", base: num(raw.base, 2) }];
    return [];
  });
}

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
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
    if (x !== axisX) body += label(px(x), py(axisY) + 13, String(x), { size: 9 });
  }
  for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax; y += yStep) {
    if (y !== axisY) body += label(px(axisX) - 4, py(y) + 3, String(y), { size: 9, anchor: "end" });
  }
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
    }
    if (path !== "") {
      body += `<path d="${path.trim()}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    }
  }
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
