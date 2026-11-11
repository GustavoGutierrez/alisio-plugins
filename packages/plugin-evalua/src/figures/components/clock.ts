import { PAPER } from "../style.js";
import { figureRoot, intParam, label, polar, segment } from "../svg.js";
import type { FigureComponent } from "../types.js";

const NUMERALS = ["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];

/** Clock-face angle (mathematical degrees) of a position measured in minutes (0 to 60). */
const faceAngle = (minutes: number): number => 90 - minutes * 6;

/**
 * An analog clock showing `hour` (1 to 12) and `minute` (0 to 59). The hour hand advances with the
 * minutes, exactly as on a real clock. The accessible text describes where each hand points, never
 * the time itself, so it is the same task for a student using a screen reader.
 */
export const clock: FigureComponent = (params, title) => {
  const hour = intParam(params.hour, 3, 1, 12);
  const minute = intParam(params.minute, 0, 0, 59);
  const cx = 100;
  const cy = 100;
  const r = 82;
  let body = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PAPER}"/>`;
  for (let tick = 0; tick < 60; tick += 1) {
    const inner = tick % 5 === 0 ? r - 9 : r - 4;
    const [x1, y1] = polar(cx, cy, inner, faceAngle(tick));
    const [x2, y2] = polar(cx, cy, r, faceAngle(tick));
    body += segment(x1, y1, x2, y2, tick % 5 === 0 ? 'stroke-width="1.6"' : 'stroke-width="0.7"');
  }
  NUMERALS.forEach((numeral, index) => {
    const [x, y] = polar(cx, cy, r - 21, faceAngle(index * 5));
    body += label(x, y + 5, numeral, { size: 14 });
  });
  const hourPosition = ((hour % 12) + minute / 60) * 5;
  const [hx, hy] = polar(cx, cy, r * 0.5, faceAngle(hourPosition));
  const [mx, my] = polar(cx, cy, r * 0.8, faceAngle(minute));
  body += segment(cx, cy, hx, hy, 'stroke-width="4.5"');
  body += segment(cx, cy, mx, my, 'stroke-width="2.2"');
  body += `<circle cx="${cx}" cy="${cy}" r="4" fill="#000" stroke="none"/>`;
  const hourLow = hour % 12 === 0 ? 12 : hour % 12;
  const hourHigh = (hour % 12) + 1;
  const hourText =
    minute === 0
      ? `la manecilla corta señala el ${hourLow}`
      : `la manecilla corta está entre el ${hourLow} y el ${hourHigh}`;
  const minuteMark = minute / 5;
  const minuteText = Number.isInteger(minuteMark)
    ? `la manecilla larga señala el ${minuteMark === 0 ? 12 : minuteMark}`
    : `la manecilla larga está ${minute % 5} marcas después del ${Math.floor(minuteMark) === 0 ? 12 : Math.floor(minuteMark)}`;
  return figureRoot(200, 200, body, title ?? "Reloj de manecillas", `${hourText}; ${minuteText}.`);
};
