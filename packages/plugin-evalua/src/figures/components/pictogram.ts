import { figureRoot, intParam, label, labels, numbers } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_ROWS = 6;
const MAX_SYMBOLS = 10;

/** One symbol at (x, y): a filled circle with a black outline, legible in monochrome. */
const symbol = (x: number, y: number): string =>
  `<circle cx="${x}" cy="${y}" r="9"/><circle cx="${x}" cy="${y}" r="3" fill="#000" stroke="none"/>`;

/**
 * A pictogram: one row per category in `labels`, `symbols[i]` symbols in row i, and a key saying
 * each symbol stands for `unit` items. Values are read as symbols x unit.
 */
export const pictogram: FigureComponent = (params, title) => {
  const names = labels(params.labels).slice(0, MAX_ROWS);
  const counts = numbers(params.symbols)
    .slice(0, names.length)
    .map((value) => Math.max(0, Math.min(MAX_SYMBOLS, Math.round(value))));
  const unit = intParam(params.unit, 1, 1, 1000);
  const width = 140 + MAX_SYMBOLS * 24;
  const height = 40 + names.length * 30 + 30;
  let body = "";
  names.forEach((name, row) => {
    const y = 30 + row * 30;
    body += label(110, y + 5, name, { size: 12, anchor: "end" });
    for (let index = 0; index < (counts[row] ?? 0); index += 1) body += symbol(130 + index * 24, y);
  });
  const keyY = 30 + names.length * 30 + 10;
  body += symbol(130, keyY);
  body += label(146, keyY + 5, `= ${unit}`, { size: 12, anchor: "start" });
  const desc = names.map((name, row) => `${name}: ${counts[row] ?? 0} símbolos`).join("; ");
  return figureRoot(
    width,
    height,
    body,
    title ?? "Pictograma",
    `${desc}. Cada símbolo vale ${unit}.`,
  );
};
