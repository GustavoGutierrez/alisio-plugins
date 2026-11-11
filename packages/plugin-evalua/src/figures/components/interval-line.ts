import { PAPER, STROKE } from "../style.js";
import { figureRoot, fmt, label, num, segment } from "../svg.js";

/** One shaded interval; a `null` end runs to infinity (an arrow at that side). */
export interface Interval {
  from: number | null;
  to: number | null;
  fromClosed: boolean;
  toClosed: boolean;
}

const end = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function intervalsOf(value: unknown): Interval[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry): Interval[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const from = end(raw.from);
    const to = end(raw.to);
    if (from !== null && to !== null && to < from) return [];
    return [{ from, to, fromClosed: raw.fromClosed === true, toClosed: raw.toClosed === true }];
  });
}

const describe = (part: Interval): string => {
  const left =
    part.from === null
      ? "menos infinito"
      : `${part.from} (${part.fromClosed ? "incluido" : "excluido"})`;
  const right =
    part.to === null ? "infinito" : `${part.to} (${part.toClosed ? "incluido" : "excluido"})`;
  return `de ${left} a ${right}`;
};

/**
 * A number line from `min` to `max` (ticks every `step`) with each of `intervals` drawn as a thick
 * band: a filled dot for a closed end, a hollow dot for an open one, an arrow for an infinite one.
 */
export function intervalLine(params: Record<string, unknown>, title?: string): string {
  const min = Math.round(num(params.min, -10));
  const max = Math.max(min + 2, Math.round(num(params.max, 10)));
  const step = Math.max(1, Math.round(num(params.step, 1)));
  const width = 500;
  const left = 34;
  const right = width - 34;
  const axis = 50;
  const x = (value: number) => left + ((value - min) / (max - min)) * (right - left);
  let body = segment(left - 14, axis, right + 14, axis);
  body += `<polygon points="${right + 20},${axis} ${right + 12},${axis - 4} ${right + 12},${axis + 4}" fill="#000" stroke="none"/>`;
  body += `<polygon points="${left - 20},${axis} ${left - 12},${axis - 4} ${left - 12},${axis + 4}" fill="#000" stroke="none"/>`;
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    body += segment(x(value), axis - 5, x(value), axis + 5);
    body += label(x(value), axis + 22, String(value), { size: 11 });
  }
  const parts = intervalsOf(params.intervals);
  for (const part of parts) {
    const a = part.from === null ? left - 8 : x(Math.max(min, part.from));
    const b = part.to === null ? right + 8 : x(Math.min(max, part.to));
    body += segment(a, axis - 12, b, axis - 12, `stroke-width="4"`);
    if (part.from === null) {
      body += `<polygon points="${fmt(a - 10)},${axis - 12} ${fmt(a)},${axis - 18} ${fmt(a)},${axis - 6}" fill="#000" stroke="none"/>`;
    }
    if (part.to === null) {
      body += `<polygon points="${fmt(b + 10)},${axis - 12} ${fmt(b)},${axis - 18} ${fmt(b)},${axis - 6}" fill="#000" stroke="none"/>`;
    }
    for (const [value, closed] of [
      [part.from, part.fromClosed],
      [part.to, part.toClosed],
    ] as const) {
      if (value === null || value < min || value > max) continue;
      body += segment(
        x(value),
        axis - 12,
        x(value),
        axis,
        'stroke-dasharray="2 2" stroke-width="1"',
      );
      body += `<circle cx="${fmt(x(value))}" cy="${axis - 12}" r="5.5" fill="${closed ? "#000" : PAPER}" stroke="${STROKE}" stroke-width="1.8"/>`;
    }
  }
  return figureRoot(
    width,
    84,
    body,
    title ?? "Intervalo en la recta numérica",
    parts.length === 0
      ? undefined
      : `Intervalo sombreado ${parts.map(describe).join("; y ")}. Punto relleno: extremo incluido; punto hueco: extremo excluido.`,
  );
}
