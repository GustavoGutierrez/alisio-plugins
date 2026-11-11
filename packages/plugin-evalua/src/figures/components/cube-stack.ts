import { GRID, PAPER } from "../style.js";
import { figureRoot, fmt, intParam } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_EDGE = 6;
const SIZE = 26;

function cube(x: number, y: number): string {
  const s = SIZE;
  const d = s / 2;
  const front = `<rect x="${fmt(x)}" y="${fmt(y - s)}" width="${s}" height="${s}"/>`;
  const top = `<polygon points="${fmt(x)},${fmt(y - s)} ${fmt(x + d)},${fmt(y - s - d)} ${fmt(x + s + d)},${fmt(y - s - d)} ${fmt(x + s)},${fmt(y - s)}" fill="${PAPER}"/>`;
  const side = `<polygon points="${fmt(x + s)},${fmt(y)} ${fmt(x + s)},${fmt(y - s)} ${fmt(x + s + d)},${fmt(y - s - d)} ${fmt(x + s + d)},${fmt(y - d)}" fill="${GRID}"/>`;
  return front + top + side;
}

/**
 * A rectangular stack of unit cubes, `length` wide, `width` deep and `height` tall (1 to 6 each),
 * drawn back to front so every hidden cube is still implied by the visible ones.
 */
export const cubeStack: FigureComponent = (params, title) => {
  const length = intParam(params.length, 3, 1, MAX_EDGE);
  const depth = intParam(params.width, 2, 1, MAX_EDGE);
  const height = intParam(params.height, 2, 1, MAX_EDGE);
  const pad = 20;
  const width = pad * 2 + length * SIZE + (depth * SIZE) / 2;
  const tall = pad * 2 + height * SIZE + (depth * SIZE) / 2;
  const baseY = tall - pad;
  let body = "";
  for (let d = depth - 1; d >= 0; d -= 1) {
    for (let z = 0; z < height; z += 1) {
      for (let x = 0; x < length; x += 1) {
        body += cube(pad + x * SIZE + (d * SIZE) / 2, baseY - z * SIZE - (d * SIZE) / 2);
      }
    }
  }
  return figureRoot(
    Math.ceil(width),
    Math.ceil(tall),
    body,
    title ?? "Prisma formado por cubos unidad",
    `${length} cubos de largo, ${depth} de ancho y ${height} de alto.`,
  );
};
