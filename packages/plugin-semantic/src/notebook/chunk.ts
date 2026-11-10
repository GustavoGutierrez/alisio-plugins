// Pure chunker (§7.4): paragraphs packed to ~1 200 characters with ~200 characters of overlap,
// never across a PDF page, hard cap 2 000 (long paragraphs split by sentence, then whitespace).

export const CHUNK_TARGET = 1200;
export const CHUNK_OVERLAP = 200;
export const CHUNK_CAP = 2000;
/** Separator placed between segments (PDF pages) in the stored source text. */
export const SEGMENT_SEPARATOR = "\n\n";

export interface Segment {
  text: string;
  page: number | null;
}
export interface Chunk {
  ordinal: number;
  text: string;
  page: number | null;
  /** Range in the joined source text (`chunkSegments().text`). */
  charStart: number;
  charEnd: number;
}

type Range = [number, number];

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Trims whitespace off a range. */
function trim(text: string, [start, end]: Range): Range {
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return [start, end];
}

/** Splits `range` into pieces no longer than `limit`, preferring the given boundary pattern. */
function splitBy(text: string, [start, end]: Range, pattern: RegExp): Range[] {
  const pieces: Range[] = [];
  let at = start;
  pattern.lastIndex = 0;
  const slice = text.slice(start, end);
  for (const match of slice.matchAll(pattern)) {
    const cut = start + (match.index ?? 0) + match[0].length;
    if (cut > at && cut < end) {
      pieces.push([at, cut]);
      at = cut;
    }
  }
  pieces.push([at, end]);
  return pieces.map((r) => trim(text, r)).filter(([s, e]) => e > s);
}

/** Units no longer than the target: paragraphs, else lines, else sentences, else words, else cuts. */
function units(text: string, range: Range): Range[] {
  const out: Range[] = [];
  for (const paragraph of splitBy(text, range, /\n\s*\n/g)) {
    if (paragraph[1] - paragraph[0] <= CHUNK_TARGET) out.push(paragraph);
    // Line-based text (spreadsheet rows, lists) keeps whole lines together.
    else out.push(...splitBy(text, paragraph, /\n/g));
  }
  return out.flatMap((unit) => (unit[1] - unit[0] <= CHUNK_TARGET ? [unit] : longUnit(text, unit)));
}

/** A line longer than the target: sentences, else words, else hard cuts. */
function longUnit(text: string, paragraph: Range): Range[] {
  const out: Range[] = [];
  for (const sentence of splitBy(text, paragraph, /[.!?;。！？]+["'”’)\]]*\s+/g)) {
    if (sentence[1] - sentence[0] <= CHUNK_TARGET) {
      out.push(sentence);
      continue;
    }
    let at = sentence[0];
    while (at < sentence[1]) {
      let cut = Math.min(sentence[1], at + CHUNK_TARGET);
      if (cut < sentence[1]) {
        let space = cut;
        while (space > at + CHUNK_TARGET / 2 && !isSpace(text[space])) space--;
        if (space > at + CHUNK_TARGET / 2) cut = space;
      }
      const piece = trim(text, [at, cut]);
      if (piece[1] > piece[0]) out.push(piece);
      at = cut;
    }
  }
  return out;
}

/** Packs units into overlapping chunks inside one segment. */
function pack(text: string, list: Range[]): Range[] {
  const chunks: Range[] = [];
  let i = 0;
  let start = list[0]?.[0] ?? 0;
  while (i < list.length) {
    let end = (list[i] as Range)[1];
    let j = i + 1;
    while (j < list.length && (list[j] as Range)[1] - start <= CHUNK_TARGET) {
      end = (list[j] as Range)[1];
      j++;
    }
    chunks.push(trim(text, [start, end]));
    if (j >= list.length) break;
    // Overlap: restart up to CHUNK_OVERLAP characters before the end, at a word boundary, but
    // never before the start of the next unit minus the overlap, so the next chunk fits the target.
    const next = list[j] as Range;
    const floor = Math.max(start + 1, end - CHUNK_OVERLAP, next[1] - CHUNK_TARGET);
    // Prefer restarting at a unit boundary (a line or paragraph) inside the overlap window.
    const aligned = list.slice(i, j).find(([s]) => s >= floor && s < next[0])?.[0];
    let overlap = aligned ?? floor;
    if (aligned === undefined) while (overlap < next[0] && !isSpace(text[overlap - 1])) overlap++;
    start = Math.min(overlap, next[0]);
    i = j;
  }
  return chunks.filter(([s, e]) => e > s);
}

/** Joins segments with blank lines and chunks each one on its own. */
export function chunkSegments(segments: Segment[]): { text: string; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  let text = "";
  segments.forEach((segment, index) => {
    if (index > 0) text += SEGMENT_SEPARATOR;
    const offset = text.length;
    text += segment.text;
    const range = trim(text, [offset, text.length]);
    if (range[1] <= range[0]) return;
    for (const [start, end] of pack(text, units(text, range)))
      chunks.push({
        ordinal: chunks.length,
        text: text.slice(start, end),
        page: segment.page,
        charStart: start,
        charEnd: end,
      });
  });
  return { text, chunks };
}
