import { figureRoot, fmt, label, labels, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

type Point = [number, number];

const mid = (p: Point, q: Point): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const poly = (points: readonly Point[]): string =>
  `<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"/>`;

/** A side label pushed `offset` pixels away from the triangle's centre, so it never sits on a line. */
function sideLabel(p: Point, q: Point, centre: Point, text: string, offset = 12): string {
  if (text === "") return "";
  const [mx, my] = mid(p, q);
  const dx = mx - centre[0];
  const dy = my - centre[1];
  const length = Math.hypot(dx, dy) || 1;
  return label(mx + (dx / length) * offset, my + (dy / length) * offset + 4, text, { size: 12 });
}

/** Two small arrowheads on a segment: the usual "these lines are parallel" mark. */
function parallelMark(p: Point, q: Point): string {
  const [mx, my] = mid(p, q);
  return `<path d="M${fmt(mx - 5)} ${fmt(my - 4)} L${fmt(mx)} ${fmt(my)} L${fmt(mx - 5)} ${fmt(my + 4)}" fill="none"/>`;
}

const SHAPE: readonly Point[] = [
  [0, 0],
  [1, 0],
  [0.3, -0.75],
];

/**
 * The unit shape of ABC: from `sides` `[AB, BC, CA]` when they form a triangle (so the drawing has
 * the true proportions), else a generic scalene shape. AB is horizontal with length 1.
 */
function shapeOf(value: unknown): readonly Point[] {
  const [ab, bc, ca] = Array.isArray(value) ? value.map((entry) => num(entry, 0)) : [];
  if (ab === undefined || bc === undefined || ca === undefined) return SHAPE;
  if (ab <= 0 || bc <= 0 || ca <= 0 || ab >= bc + ca || bc >= ab + ca || ca >= ab + bc) {
    return SHAPE;
  }
  const x = (ab * ab + ca * ca - bc * bc) / (2 * ab);
  const y = Math.sqrt(Math.max(0, ca * ca - x * x));
  // Keep the apex over a readable base: very flat or very tall shapes fall back to the generic one.
  if (y / ab < 0.2 || y / ab > 1.6 || x / ab < -0.3 || x / ab > 1.3) return SHAPE;
  return [
    [0, 0],
    [1, 0],
    [x / ab, -y / ab],
  ];
}

/** `pair`: triangle ABC and a copy DEF scaled by `ratio`, each side labelled. */
function pair(params: Record<string, unknown>, title?: string): string {
  const ratio = Math.max(0.4, Math.min(2.5, num(params.ratio, 1.5)));
  const shape = shapeOf(params.sides);
  const tall = Math.max(0.75, ...shape.map(([, y]) => -y));
  const left = labels(params.labels);
  const right = labels(params.imageLabels);
  const unit = Math.min(150, 112 / tall) / Math.max(1, ratio);
  const low = Math.min(0, ...shape.map(([x]) => x));
  const small = shape.map(([x, y]): Point => [20 + (x - low) * unit, 170 + y * unit]);
  const shift = 60 + (1 - low) * unit;
  const big = shape.map(
    ([x, y]): Point => [shift + (x - low) * unit * ratio, 170 + y * unit * ratio],
  );
  let body = "";
  for (const [shape, names, sides] of [
    [small, ["A", "B", "C"], left],
    [big, ["D", "E", "F"], right],
  ] as const) {
    const [a, b, c] = shape as [Point, Point, Point];
    const centre: Point = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    body += poly(shape);
    body += sideLabel(a, b, centre, sides[0] ?? "");
    body += sideLabel(b, c, centre, sides[1] ?? "");
    body += sideLabel(c, a, centre, sides[2] ?? "");
    body += label(a[0] - 8, a[1] + 14, names[0]) + label(b[0] + 8, b[1] + 14, names[1]);
    body += label(c[0], c[1] - 8, names[2]);
  }
  const high = Math.max(1, ...shape.map(([x]) => x)) - low;
  const width = Math.ceil(shift + high * unit * ratio + 30);
  return figureRoot(
    width,
    200,
    body,
    title ?? "Triángulos semejantes ABC y DEF",
    `Lados de ABC: ${left.join(", ")}. Lados de DEF: ${right.join(", ")}.`,
  );
}

/**
 * `nested` (Thales): triangle ABC with D on AB and E on AC such that DE is parallel to BC, placed
 * at the fraction `cut` of each side; `labels` are AD, DB, AE and EC.
 */
function nested(params: Record<string, unknown>, title?: string): string {
  const cut = Math.max(0.25, Math.min(0.75, num(params.cut, 0.5)));
  const [ad, db, ae, ec] = labels(params.labels);
  const a: Point = [150, 20];
  const b: Point = [30, 200];
  const c: Point = [280, 200];
  const d: Point = [a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut];
  const e: Point = [a[0] + (c[0] - a[0]) * cut, a[1] + (c[1] - a[1]) * cut];
  const centre: Point = [150, 140];
  let body = poly([a, b, c]) + segment(d[0], d[1], e[0], e[1]);
  body += parallelMark(d, e) + parallelMark(b, c);
  body += sideLabel(a, d, centre, ad ?? "", 14) + sideLabel(d, b, centre, db ?? "", 14);
  body += sideLabel(a, e, centre, ae ?? "", 14) + sideLabel(e, c, centre, ec ?? "", 14);
  body += label(a[0], a[1] - 6, "A") + label(b[0] - 10, b[1] + 6, "B");
  body += label(c[0] + 10, c[1] + 6, "C") + label(d[0] - 12, d[1], "D");
  body += label(e[0] + 12, e[1], "E");
  return figureRoot(
    310,
    225,
    body,
    title ?? "Teorema de Tales: DE paralela a BC",
    `AD = ${ad ?? "?"}, DB = ${db ?? "?"}, AE = ${ae ?? "?"}, EC = ${ec ?? "?"}.`,
  );
}

/** Similar triangles side by side (`mode: "pair"`) or a Thales configuration (`mode: "nested"`). */
export const similarTriangles: FigureComponent = (params, title) =>
  params.mode === "nested" ? nested(params, title) : pair(params, title);
