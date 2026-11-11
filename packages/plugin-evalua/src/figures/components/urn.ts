import { PAPER } from "../style.js";
import { figureRoot, label, labels, numbers } from "../svg.js";
import type { FigureComponent } from "../types.js";

const MAX_BALLS = 30;
const PER_ROW = 6;

/**
 * A bag of balls: `counts[i]` balls marked with the letter `marks[i]`, plus a key from each letter
 * to its name in `names`. Letters, not colours, carry the category, so it prints in monochrome.
 */
export const urn: FigureComponent = (params, title) => {
  const marks = labels(params.marks);
  const names = labels(params.names);
  const counts = numbers(params.counts).map((value) => Math.max(0, Math.round(value)));
  const balls: string[] = [];
  marks.forEach((mark, index) => {
    for (let n = 0; n < (counts[index] ?? 0) && balls.length < MAX_BALLS; n += 1) balls.push(mark);
  });
  const rows = Math.max(1, Math.ceil(balls.length / PER_ROW));
  const bagHeight = 40 + rows * 30;
  let body = `<path d="M30 30 L30 ${30 + bagHeight} Q30 ${50 + bagHeight} 50 ${50 + bagHeight} L210 ${50 + bagHeight} Q230 ${50 + bagHeight} 230 ${30 + bagHeight} L230 30" fill="${PAPER}"/>`;
  balls.forEach((mark, index) => {
    const x = 55 + (index % PER_ROW) * 30;
    const y = 30 + bagHeight - Math.floor(index / PER_ROW) * 30;
    body += `<circle cx="${x}" cy="${y}" r="12"/>`;
    body += label(x, y + 4, mark, { size: 12 });
  });
  const keyY = 80 + bagHeight;
  const key = marks.map((mark, index) => `${mark} = ${names[index] ?? mark}`);
  body += label(30, keyY, key.join("   "), { size: 12, anchor: "start" });
  const desc = marks.map((mark, index) => `${counts[index] ?? 0} ${names[index] ?? mark}`);
  return figureRoot(
    260,
    keyY + 14,
    body,
    title ?? `Bolsa con ${balls.length} bolas`,
    `${desc.join(", ")}.`,
  );
};
