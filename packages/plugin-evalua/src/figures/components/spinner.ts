import { PAPER } from "../style.js";
import { figureRoot, label, labels, polar, sectorPath, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_SECTORS = 12;

/** A spinner of equal sectors, one per entry of `sectors`, each named by its text. */
export const spinner: FigureComponent = (params, title) => {
  const sectors = labels(params.sectors).slice(0, MAX_SECTORS);
  const count = Math.max(1, sectors.length);
  const cx = 110;
  const cy = 110;
  const r = 88;
  const sweep = 360 / count;
  let body = "";
  sectors.forEach((name, index) => {
    const to = 90 - index * sweep;
    const from = to - sweep;
    body += `<path d="${sectorPath(cx, cy, r, from, to)}" fill="${PAPER}"/>`;
    const [x, y] = polar(cx, cy, r * 0.62, (from + to) / 2);
    body += label(x, y + 4, name, { size: count > 8 ? 10 : 12 });
  });
  const [ax, ay] = polar(cx, cy, r * 0.45, 60);
  body += segment(cx, cy, ax, ay, 'stroke-width="3"');
  body += `<circle cx="${cx}" cy="${cy}" r="5" fill="#000" stroke="none"/>`;
  return figureRoot(
    220,
    220,
    body,
    title ?? `Ruleta dividida en ${count} partes iguales`,
    `Partes: ${sectors.join(", ")}.`,
  );
};
