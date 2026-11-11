/**
 * Interval notation shared by the inequality and function-property families. A set of reals is a
 * union of intervals with whole (or `null` = infinite) ends; its canonical text (`(-inf,3]U(5,inf)`)
 * is the same for equal sets, and its LaTeX uses `\infty` and `\cup`. The number-line figure draws
 * the very same intervals.
 */

import type { OptionCandidate } from "./options.js";

export interface Span {
  from: number | null;
  to: number | null;
  fromClosed: boolean;
  toClosed: boolean;
}

export const span = (
  from: number | null,
  to: number | null,
  fromClosed = false,
  toClosed = false,
): Span => ({
  from,
  to,
  fromClosed: from !== null && fromClosed,
  toClosed: to !== null && toClosed,
});

/** Sorted by left end; infinite left ends first. */
const ordered = (parts: readonly Span[]): Span[] =>
  [...parts].sort((left, right) => (left.from ?? -Infinity) - (right.from ?? -Infinity));

export function intervalText(parts: readonly Span[]): string {
  return ordered(parts)
    .map(
      (part) =>
        `${part.fromClosed ? "[" : "("}${part.from ?? "-inf"},${part.to ?? "inf"}${part.toClosed ? "]" : ")"}`,
    )
    .join("U");
}

export function intervalLatex(parts: readonly Span[]): string {
  return ordered(parts)
    .map(
      (part) =>
        `\\left${part.fromClosed ? "[" : "("}${part.from ?? "-\\infty"}, ${part.to ?? "\\infty"}\\right${part.toClosed ? "]" : ")"}`,
    )
    .join(" \\cup ");
}

export const intervalChoice = (parts: readonly Span[], error: string): OptionCandidate => ({
  value: intervalText(parts),
  display: `$${intervalLatex(parts)}$`,
  error,
});

/** Every end open (a classic bracket mistake), or every end closed. */
export const allEnds = (parts: readonly Span[], closed: boolean): Span[] =>
  parts.map((part) => span(part.from, part.to, closed, closed));

/** The complement of one bounded interval or one ray (two rays, or one ray). */
export function complement(part: Span): Span[] {
  const out: Span[] = [];
  if (part.from !== null) out.push(span(null, part.from, false, !part.fromClosed));
  if (part.to !== null) out.push(span(part.to, null, !part.toClosed, false));
  return out;
}

/** The figure params of a number line that shows `parts`, with a window around their ends. */
export function intervalFigure(parts: readonly Span[]): Record<string, unknown> {
  const ends = parts
    .flatMap((part) => [part.from, part.to])
    .filter((value): value is number => value !== null);
  const low = Math.min(...ends);
  const high = Math.max(...ends);
  const min = Math.floor(low) - 3;
  const max = Math.max(min + 6, Math.ceil(high) + 3);
  return {
    min,
    max,
    step: max - min > 16 ? 2 : 1,
    intervals: parts.map((part) => ({ ...part })),
  };
}
