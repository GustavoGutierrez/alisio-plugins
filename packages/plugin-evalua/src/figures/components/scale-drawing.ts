import { PAPER } from "../style.js";
import { dot, figureRoot, fmt, label, measureText, num, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** Pixels per drawn centimetre, so a 6 cm route looks twice as long as a 3 cm one. */
const CM = 26;

/** A map: two named places joined by a dashed route of `length` cm, and the scale legend. */
function map(params: Record<string, unknown>, title?: string): string {
  const length = Math.max(1, Math.min(11, num(params.length, 4)));
  const from = typeof params.from === "string" ? params.from : "A";
  const to = typeof params.to === "string" ? params.to : "B";
  const scale = typeof params.scale === "string" ? params.scale : "";
  const text = measureText(params.shown ?? params.length, "cm");
  // Half the width of each end label (13 px serif, about 7.2 px per character) keeps it inside.
  const half = (name: string) => Math.ceil(name.length * 3.6) + 4;
  const x1 = Math.max(40, 20 + half(from));
  const x2 = x1 + length * CM;
  const width = Math.max(220, Math.round(x2 + Math.max(40, 20 + half(to))));
  let body = `<rect x="10" y="10" width="${width - 20}" height="130" rx="6" fill="${PAPER}"/>`;
  body += segment(x1, 70, x2, 70, 'stroke-dasharray="6 4" stroke-width="1.8"');
  body += dot(x1, 70, 5) + dot(x2, 70, 5);
  body += label(x1, 58, from, { size: 13 }) + label(x2, 58, to, { size: 13 });
  body += label((x1 + x2) / 2, 90, text, { size: 12 });
  if (scale !== "") body += label(20, 128, `Escala ${scale}`, { size: 12, anchor: "start" });
  return figureRoot(
    width,
    150,
    body,
    title ?? `Mapa de ${from} a ${to}`,
    `En el mapa, de ${from} a ${to} hay ${text}.${scale === "" ? "" : ` Escala ${scale}.`}`,
  );
}

/** A floor plan: a `width` by `height` cm rectangle with both sides labelled, and the scale. */
function plan(params: Record<string, unknown>, title?: string): string {
  const w = Math.max(1, Math.min(10, num(params.width, 6)));
  const h = Math.max(1, Math.min(6, num(params.height, 3)));
  const scale = typeof params.scale === "string" ? params.scale : "";
  const across = measureText(params.width, "cm");
  const down = measureText(params.height, "cm");
  const x = 50;
  const y = 20;
  const pw = w * CM;
  const ph = h * CM;
  let body = `<rect x="${x}" y="${y}" width="${fmt(pw)}" height="${fmt(ph)}"/>`;
  body += label(x + pw / 2, y + ph + 16, across, { size: 12 });
  body += label(x - 6, y + ph / 2 + 4, down, { size: 12, anchor: "end" });
  if (scale !== "") body += label(x, y + ph + 36, `Escala ${scale}`, { size: 12, anchor: "start" });
  return figureRoot(
    Math.round(x + pw + 30),
    Math.round(y + ph + 46),
    body,
    title ?? "Plano a escala",
    `Rectángulo de ${across} por ${down} en el plano.${scale === "" ? "" : ` Escala ${scale}.`}`,
  );
}

/** A scale drawing: a map route (`shape: "map"`, the default) or a rectangular floor plan. */
export const scaleDrawing: FigureComponent = (params, title) =>
  params.shape === "plan" ? plan(params, title) : map(params, title);
