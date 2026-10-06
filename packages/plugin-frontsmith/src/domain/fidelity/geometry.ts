export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxError {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** `max(|dx|, |dy|, |dw|, |dh|)`: the element's error in CSS pixels (FID 15.3). */
  e: number;
}

/** Per-coordinate differences between a reference and an actual box. */
export function boxError(reference: Box, actual: Box): BoxError {
  const dx = Math.abs(actual.x - reference.x);
  const dy = Math.abs(actual.y - reference.y);
  const dw = Math.abs(actual.width - reference.width);
  const dh = Math.abs(actual.height - reference.height);
  return { dx, dy, dw, dh, e: Math.max(dx, dy, dw, dh) };
}

/** Every coordinate error of a list of box pairs, flattened (4 per pair). */
export function coordinateErrors(references: readonly Box[], actuals: readonly Box[]): number[] {
  const out: number[] = [];
  references.forEach((reference, i) => {
    const e = boxError(reference, actuals[i] as Box);
    out.push(e.dx, e.dy, e.dw, e.dh);
  });
  return out;
}

export interface Summary {
  median: number;
  p95: number;
  max: number;
  count: number;
}

/**
 * Median, nearest-rank 95th percentile and maximum. The p95 never exonerates the worst 5 percent:
 * callers also list every critical element (FID 15.3).
 */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { median: 0, p95: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    median,
    p95: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number,
    max: sorted[sorted.length - 1] as number,
    count: sorted.length,
  };
}

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
