import { PAPER, PASTELS } from "../style.js";
import { figureRoot, hatch, line, num, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/**
 * A bar split into `parts` equal cells with the first `shaded` ones filled. `hatch: true` also
 * hatches the shaded cells so they read on a monochrome printer, and adds an accessible title.
 */
export const fractionBar: FigureComponent = (params, title) => {
  const parts = Math.max(1, Math.min(20, num(params.parts, 4)));
  const shaded = Math.max(0, Math.min(parts, num(params.shaded, 1)));
  const width = 340;
  const height = 90;
  const left = 30;
  const top = 30;
  const barWidth = width - 60;
  const barHeight = 40;
  const cell = barWidth / parts;
  // The bar stays white: the shading is what carries the fraction, so it keeps its own fill.
  let body = `<rect x="${left}" y="${top}" width="${barWidth}" height="${barHeight}" fill="${PAPER}"/>`;
  for (let index = 1; index < parts; index += 1) {
    body += line(left + index * cell, top, left + index * cell, top + barHeight);
  }
  for (let index = 0; index < shaded; index += 1) {
    body += `<rect x="${left + index * cell}" y="${top}" width="${cell}" height="${barHeight}" fill="${PASTELS[0]}" stroke="none"/>`;
    if (params.hatch === true) body += hatch(left + index * cell, top, cell, barHeight);
  }
  body += `<rect x="${left}" y="${top}" width="${barWidth}" height="${barHeight}" fill="none"/>`;
  if (params.hatch !== true) return wrap(width, height, body, `${shaded} of ${parts}`);
  return figureRoot(
    width,
    height,
    body,
    title ??
      `Barra dividida en ${parts} partes iguales con ${shaded} ${shaded === 1 ? "sombreada" : "sombreadas"}`,
  );
};
