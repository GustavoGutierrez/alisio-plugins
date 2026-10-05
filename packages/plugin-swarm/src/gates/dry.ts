/** Duplicate-block detector for the `dry` gate: normalised line windows seen in two places. */

export interface SourceText {
  path: string;
  text: string;
}

export interface DryOptions {
  /** Consecutive significant lines that make a block (default 6). */
  window?: number;
  /** Report only duplicates that involve one of these paths (the changed files). */
  only?: string[];
  maxFindings?: number;
}

interface Line {
  text: string;
  number: number;
}

const COMMENT = /^(\/\/|\/\*|\*|\*\/|#)/;
const TRIVIAL = /^[\s{}()[\];,.]*$/;

function significant(text: string): Line[] {
  const out: Line[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (line.length < 4 || COMMENT.test(line) || TRIVIAL.test(line)) continue;
    out.push({ text: line, number: index + 1 });
  }
  return out;
}

interface Hit {
  file: number;
  index: number;
}

export function detectDuplicates(files: SourceText[], options: DryOptions = {}): string[] {
  const window = options.window ?? 6;
  const max = options.maxFindings ?? 20;
  const lines = files.map((file) => significant(file.text));
  const seen = new Map<string, Hit[]>();
  for (const [file, list] of lines.entries()) {
    for (let index = 0; index + window <= list.length; index += 1) {
      const key = list
        .slice(index, index + window)
        .map((line) => line.text)
        .join("\n");
      const hits = seen.get(key) ?? [];
      hits.push({ file, index });
      seen.set(key, hits);
    }
  }
  // Pair every later occurrence with the first one, then merge consecutive windows into one block.
  const runs = new Map<string, Array<{ i: number; j: number }>>();
  for (const hits of seen.values()) {
    const first = hits[0] as Hit;
    for (const other of hits.slice(1)) {
      if (other.file === first.file && other.index - first.index < window) continue;
      const key = `${first.file}|${other.file}`;
      const list = runs.get(key) ?? [];
      list.push({ i: first.index, j: other.index });
      runs.set(key, list);
    }
  }
  const findings: string[] = [];
  for (const [key, list] of runs) {
    const [a, b] = key.split("|").map(Number) as [number, number];
    const pathA = (files[a] as SourceText).path;
    const pathB = (files[b] as SourceText).path;
    if (options.only && !options.only.includes(pathA) && !options.only.includes(pathB)) continue;
    list.sort((x, y) => x.i - y.i || x.j - y.j);
    let start = 0;
    while (start < list.length) {
      let end = start;
      while (
        end + 1 < list.length &&
        (list[end + 1] as { i: number; j: number }).i ===
          (list[end] as { i: number; j: number }).i + 1 &&
        (list[end + 1] as { i: number; j: number }).j ===
          (list[end] as { i: number; j: number }).j + 1
      ) {
        end += 1;
      }
      const head = list[start] as { i: number; j: number };
      const size = end - start + window;
      const lineA = (lines[a] as Line[])[head.i]?.number ?? 0;
      const lineB = (lines[b] as Line[])[head.j]?.number ?? 0;
      findings.push(`Duplicate block of ${size} lines: ${pathA}:${lineA} and ${pathB}:${lineB}`);
      start = end + 1;
    }
  }
  return findings.slice(0, max);
}
