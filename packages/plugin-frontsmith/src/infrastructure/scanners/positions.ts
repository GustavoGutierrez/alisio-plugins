export interface Position {
  line: number;
  column: number;
}

/** Offset -> 1-based line and column lookup for one source text. */
export function positionIndex(source: string): (offset: number) => Position {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (starts[low] as number) + 1 };
  };
}
