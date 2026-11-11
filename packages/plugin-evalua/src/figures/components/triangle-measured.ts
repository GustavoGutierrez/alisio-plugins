import { arcPath, figureRoot, fmt, label, labels, num, segment } from "../svg.js";

type Point = [number, number];

const poly = (points: readonly Point[]): string =>
  `<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"/>`;

/** Mathematical direction (degrees, counter-clockwise, y up) from `p` to `q` in SVG space. */
const heading = (p: Point, q: Point): number =>
  (Math.atan2(p[1] - q[1], q[0] - p[0]) * 180) / Math.PI;

/** An arc of radius `r` at `vertex` between the rays to `p` and `q`, with `text` in its middle. */
function angleMark(vertex: Point, p: Point, q: Point, text: string, r = 22): string {
  let from = heading(vertex, p);
  let to = heading(vertex, q);
  if ((to - from + 360) % 360 > 180) [from, to] = [to, from];
  if (to < from) to += 360;
  const middle = ((from + to) / 2) * (Math.PI / 180);
  const reach = r + 14;
  const tx = vertex[0] + reach * Math.cos(middle);
  const ty = vertex[1] - reach * Math.sin(middle) + 4;
  return (
    `<path d="${arcPath(vertex[0], vertex[1], r, from, to)}" fill="none"/>` +
    label(tx, ty, text, { size: 12 })
  );
}

/**
 * A right triangle drawn to scale from its legs (`legs: [horizontal, vertical]`), with the right
 * angle marked at C and `sideLabels` `[horizontal leg, vertical leg, hypotenuse]` on its sides.
 * `angleAt: "A" | "B"` marks the acute angle at that vertex with `angleLabel` (default `θ`).
 */
export function rightTriangle(params: Record<string, unknown>, title?: string): string {
  const raw = Array.isArray(params.legs) ? params.legs : [];
  const p = Math.max(1, num(raw[0], 3));
  const q = Math.max(1, num(raw[1], 4));
  // Long thin triangles are widened to a readable 1:4 at most; the labels carry the true sizes.
  const ratio = Math.max(0.25, Math.min(4, q / p));
  const w = Math.min(220, 150 / ratio);
  const h = w * ratio;
  const c: Point = [40, 20 + h];
  const a: Point = [40 + w, 20 + h];
  const b: Point = [40, 20];
  const [horizontal, vertical, hypotenuse] = labels(params.sideLabels);
  let body = poly([a, b, c]);
  body += `<path d="M${fmt(c[0] + 14)} ${fmt(c[1])} L${fmt(c[0] + 14)} ${fmt(c[1] - 14)} L${fmt(c[0])} ${fmt(c[1] - 14)}" fill="none"/>`;
  body += label((a[0] + c[0]) / 2, c[1] + 18, horizontal ?? "");
  body += label(c[0] - 8, (b[1] + c[1]) / 2 + 4, vertical ?? "", { anchor: "end" });
  body += label((a[0] + b[0]) / 2 + 10, (a[1] + b[1]) / 2 - 6, hypotenuse ?? "", {
    anchor: "start",
  });
  body += label(a[0] + 10, a[1] + 4, "A", { anchor: "start" }) + label(b[0], b[1] - 6, "B");
  body += label(c[0] - 10, c[1] + 14, "C");
  const at = params.angleAt === "A" || params.angleAt === "B" ? params.angleAt : undefined;
  const mark = typeof params.angleLabel === "string" ? params.angleLabel : "θ";
  if (at === "A") body += angleMark(a, b, c, mark, 30);
  if (at === "B") body += angleMark(b, c, a, mark, 26);
  return figureRoot(
    Math.ceil(w + 110),
    Math.ceil(h + 50),
    body,
    title ?? "Triángulo rectángulo ABC",
    `Catetos: ${horizontal ?? "?"} y ${vertical ?? "?"}. Hipotenusa: ${hypotenuse ?? "?"}.${at === undefined ? "" : ` Ángulo ${mark} marcado en ${at}.`}`,
  );
}

/**
 * A triangle ABC built from its interior `angles` `[A, B, C]` (degrees) on a fixed base AB, each
 * vertex marked with its entry of `angleLabels` ("" leaves it unmarked). `exterior` extends AB
 * past B and marks the exterior angle there with `exteriorLabel`.
 */
export function angledTriangle(params: Record<string, unknown>, title?: string): string {
  const raw = Array.isArray(params.angles) ? params.angles : [];
  const angleA = Math.max(5, Math.min(170, num(raw[0], 60)));
  const angleB = Math.max(5, Math.min(175 - angleA, num(raw[1], 60)));
  const rad = Math.PI / 180;
  const base = 200;
  // Law of sines: AC = AB · sin B / sin C, with C the remaining angle.
  const side = (base * Math.sin(angleB * rad)) / Math.sin((180 - angleA - angleB) * rad);
  const apexX = side * Math.cos(angleA * rad);
  const apexY = side * Math.sin(angleA * rad);
  const fit = Math.min(1, 140 / Math.max(1, apexY));
  const left = 40 + Math.max(0, -apexX * fit);
  const a: Point = [left, 30 + apexY * fit];
  const b: Point = [left + base * fit, a[1]];
  const c: Point = [left + apexX * fit, a[1] - apexY * fit];
  const marks = labels(params.angleLabels);
  let body = poly([a, b, c]);
  if (marks[0]) body += angleMark(a, b, c, marks[0]);
  if (marks[1]) body += angleMark(b, c, a, marks[1]);
  if (marks[2]) body += angleMark(c, a, b, marks[2], 18);
  const exterior = params.exterior === true;
  const end: Point = [b[0] + 70, b[1]];
  if (exterior) {
    body += segment(b[0], b[1], end[0], end[1]);
    const text = typeof params.exteriorLabel === "string" ? params.exteriorLabel : "?";
    body += angleMark(b, end, c, text, 16);
  }
  body += label(a[0] - 10, a[1] + 14, "A") + label(b[0] + 4, b[1] + 16, "B");
  body += label(c[0], c[1] - 8, "C");
  const width = Math.ceil(Math.max(b[0], c[0], exterior ? end[0] : 0) + 40);
  const shown = marks.map((mark, index) => `${"ABC"[index]}: ${mark || "sin marcar"}`);
  return figureRoot(
    width,
    Math.ceil(a[1] + 30),
    body,
    title ?? "Triángulo ABC",
    `Ángulos ${shown.join(", ")}.${exterior ? " Ángulo exterior marcado en B." : ""}`,
  );
}
