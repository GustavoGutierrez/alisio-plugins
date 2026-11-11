import { PAPER, PASTELS } from "../style.js";
import { figureRoot, hatchSector, intParam, sectorPath } from "../svg.js";
import type { FigureComponent } from "../types.js";

/**
 * A circle cut into `parts` equal sectors (1 to 16), the first `shaded` filled and hatched,
 * starting at twelve o'clock and going clockwise.
 */
export const fractionCircle: FigureComponent = (params, title) => {
  const parts = intParam(params.parts, 4, 1, 16);
  const shaded = intParam(params.shaded, 1, 0, parts);
  const cx = 100;
  const cy = 100;
  const r = 80;
  const sweep = 360 / parts;
  let body = "";
  for (let index = 0; index < parts; index += 1) {
    const to = 90 - index * sweep;
    const from = to - sweep;
    const filled = index < shaded;
    body += `<path d="${sectorPath(cx, cy, r, from, to)}" fill="${filled ? PASTELS[0] : PAPER}"/>`;
    if (filled) body += hatchSector(cx, cy, r, from, to);
  }
  return figureRoot(
    200,
    200,
    body,
    title ??
      `Círculo dividido en ${parts} partes iguales con ${shaded} ${shaded === 1 ? "sombreada" : "sombreadas"}`,
  );
};
