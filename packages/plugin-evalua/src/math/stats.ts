/**
 * Exact descriptive statistics over small integer data sets, shared by the box-plot family and the
 * later dispersion topics. Everything returns a `Rational`, so a half-way median or a fractional
 * mean stays exact.
 */

import { Rational } from "./rational.js";

export const ascending = (data: readonly number[]): number[] =>
  [...data].sort((left, right) => left - right);

export function mean(data: readonly number[]): Rational {
  if (data.length === 0) return Rational.zero;
  return Rational.of(
    data.reduce((sum, value) => sum + value, 0),
    data.length,
  );
}

/** The median: the middle value, or the average of the two middle values. */
export function median(data: readonly number[]): Rational {
  const ordered = ascending(data);
  const count = ordered.length;
  if (count === 0) return Rational.zero;
  const middle = Math.floor(count / 2);
  return count % 2 === 1
    ? Rational.of(ordered[middle] ?? 0)
    : Rational.of((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0), 2);
}

export interface FiveNumbers {
  min: Rational;
  q1: Rational;
  median: Rational;
  q3: Rational;
  max: Rational;
}

/**
 * The five-number summary with the school (Tukey) rule: Q1 and Q3 are the medians of the lower
 * and upper halves, leaving the middle value out of both halves when the count is odd.
 */
export function fiveNumbers(data: readonly number[]): FiveNumbers {
  const ordered = ascending(data);
  const half = Math.floor(ordered.length / 2);
  const lower = ordered.slice(0, half);
  const upper = ordered.slice(ordered.length - half);
  return {
    min: Rational.of(ordered[0] ?? 0),
    q1: median(lower),
    median: median(ordered),
    q3: median(upper),
    max: Rational.of(ordered[ordered.length - 1] ?? 0),
  };
}

/** Population variance `Σ(x - x̄)² / n`, exact. */
export function variance(data: readonly number[]): Rational {
  if (data.length === 0) return Rational.zero;
  const average = mean(data);
  let total = Rational.zero;
  for (const value of data) {
    const deviation = Rational.of(value).sub(average);
    total = total.add(deviation.mul(deviation));
  }
  return total.div(Rational.of(data.length));
}
