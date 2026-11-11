import { STROKE } from "../style.js";
import { dot, figureRoot, fmt, gridLine, label, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** The largest grid span drawn, so cells stay readable (and tick labels never collide). */
const MAX_SPAN = 20;
const PLOT = 240;
const PAD = 30;

interface Window {
  min: number;
  max: number;
}

/** A square integer window covering the origin and every value in `values`, one unit of margin. */
function windowOf(values: readonly number[]): Window {
  let min = Math.floor(Math.min(0, ...values)) - 1;
  let max = Math.ceil(Math.max(0, ...values)) + 1;
  if (max - min > MAX_SPAN) {
    const middle = Math.round((min + max) / 2);
    min = middle - MAX_SPAN / 2;
    max = middle + MAX_SPAN / 2;
  }
  return { min, max };
}

/**
 * A conic on a numbered grid. `shape: "circle"` draws the circle of centre `(h, k)` and radius `r`
 * with the centre `C` and a radius marked; `shape: "parabola"` draws `(x - h)² = 4p(y - k)`
 * (`axis: "vertical"`, the default) or `(y - k)² = 4p(x - h)` (`axis: "horizontal"`) with the
 * vertex dot, the focus `F` and the dashed directrix.
 */
export const conic: FigureComponent = (params, title) => {
  const h = num(params.h, 0);
  const k = num(params.k, 0);
  const isCircle = params.shape !== "parabola";
  const r = Math.max(0.5, Math.abs(num(params.r, 3)));
  const p = num(params.p, 1) === 0 ? 1 : num(params.p, 1);
  const vertical = params.axis !== "horizontal";
  // The parabola is drawn out to where it is 4|p| wide on each side of its axis.
  const along = vertical ? k : h;
  const across = vertical ? h : k;
  const extentAlong = [along - p, along + p, along + 4 * p];
  const extentAcross = [across - 4 * Math.abs(p), across + 4 * Math.abs(p)];
  const xs = isCircle ? [h - r, h + r] : vertical ? extentAcross : extentAlong;
  const ys = isCircle ? [k - r, k + r] : vertical ? extentAlong : extentAcross;
  const window = windowOf([...xs, ...ys]);
  const span = window.max - window.min;
  const cell = PLOT / span;
  const px = (x: number) => PAD + (x - window.min) * cell;
  const py = (y: number) => PAD + (window.max - y) * cell;
  const every = span > 12 ? 2 : 1;
  let body = "";
  for (let value = window.min; value <= window.max; value += 1) {
    body += gridLine(px(value), py(window.min), px(value), py(window.max));
    body += gridLine(px(window.min), py(value), px(window.max), py(value));
  }
  body += segment(px(window.min), py(0), px(window.max) + 10, py(0));
  body += segment(px(0), py(window.min), px(0), py(window.max) - 10);
  body += label(px(window.max) + 14, py(0) + 4, "x", { anchor: "start" });
  body += label(px(0), py(window.max) - 14, "y");
  for (let value = window.min; value <= window.max; value += 1) {
    if (value === 0 || value % every !== 0) continue;
    body += label(px(value), py(0) + 13, String(value), { size: 9 });
    body += label(px(0) - 4, py(value) + 3, String(value), { size: 9, anchor: "end" });
  }
  let desc: string;
  if (isCircle) {
    body += `<circle cx="${fmt(px(h))}" cy="${fmt(py(k))}" r="${fmt(r * cell)}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    body += segment(px(h), py(k), px(h + r), py(k), 'stroke-width="1.6" stroke-dasharray="5 3"');
    body += dot(px(h), py(k));
    body += label(px(h) - 6, py(k) - 7, "C", { size: 13, anchor: "end" });
    // Below the radius: above it the name of the centre already sits.
    body += label(px(h + r * 0.7), py(k) + 15, "r", { size: 12 });
    desc = `Circunferencia de centro C(${fmt(h)}, ${fmt(k)}) y radio ${fmt(r)}.`;
  } else {
    let path = "";
    const samples = 120;
    for (let index = 0; index <= samples; index += 1) {
      const t = across - 4 * Math.abs(p) + (8 * Math.abs(p) * index) / samples;
      const s = along + (t - across) ** 2 / (4 * p);
      const [x, y] = vertical ? [t, s] : [s, t];
      if (x < window.min || x > window.max || y < window.min || y > window.max) continue;
      path += `${path === "" ? "M" : "L"}${fmt(px(x))} ${fmt(py(y))} `;
    }
    body += `<path d="${path.trim()}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    const [fx, fy] = vertical ? [h, k + p] : [h + p, k];
    const dashed = 'stroke-dasharray="5 3" stroke-width="1.4"';
    body += vertical
      ? segment(px(window.min), py(k - p), px(window.max), py(k - p), dashed)
      : segment(px(h - p), py(window.min), px(h - p), py(window.max), dashed);
    // The vertex is a dot only: at the origin a name would sit on the axis tick labels. The focus
    // name goes on the side of the axis of symmetry that has no tick labels.
    body += dot(px(h), py(k)) + dot(px(fx), py(fy));
    body += vertical
      ? label(px(fx) + 8, py(fy) + 4, "F", { size: 13, anchor: "start" })
      : label(px(fx), py(fy) - 9, "F", { size: 13 });
    desc = `Parábola de vértice (${fmt(h)}, ${fmt(k)}) y foco F(${fmt(fx)}, ${fmt(fy)}); la directriz es la recta discontinua ${vertical ? `y = ${fmt(k - p)}` : `x = ${fmt(h - p)}`}.`;
  }
  return figureRoot(
    PAD * 2 + PLOT + 10,
    PAD * 2 + PLOT,
    body,
    title ?? (isCircle ? "Circunferencia en el plano cartesiano" : "Parábola en el plano"),
    desc,
  );
};
