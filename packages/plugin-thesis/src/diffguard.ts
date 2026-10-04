/**
 * The editor's diff guard (spec 7.4): an edit pass may rewrite wording but must leave citations,
 * claim anchors, numbers, labels, math, link targets and footnote marks exactly as they were. The
 * comparison is on the Markdown text, before and after; any difference rejects the whole pass.
 */

export interface ProtectedItems {
  /** `[@a; @b]`, `@key` and `@fig-x` occurrences. */
  citations: string[];
  /** Claim anchor ids in order. */
  anchors: string[];
  numbers: string[];
  /** `{#fig-x width=80%}` attribute blocks. */
  labels: string[];
  /** Math sources in order (display and inline). */
  math: string[];
  /** Link and image targets. */
  targets: string[];
  /** Footnote marks and definitions. */
  footnotes: string[];
}

const anchorPattern = /<!--\s*claim:([A-Za-z0-9_-]{1,40})\s*-->/g;
const displayMath = /\$\$[\s\S]*?\$\$/g;
const inlineMath = /(?<![\\$])\$(?![\s$])(?:[^$\n\\]|\\.)+?(?<![\s\\])\$(?!\d)/g;
const citationPattern = /\[@[^\]]*\]|(?<![\p{L}\p{N}_])@[A-Za-z0-9_][A-Za-z0-9_:.-]*/gu;
const labelPattern = /\{#[^}]*\}/g;
const targetPattern = /\]\(([^)\s]*)/g;
const footnotePattern = /\[\^[^\]\s]+\]/g;
const numberPattern = /\d+(?:[.,]\d+)*/g;

const squash = (value: string) => value.replace(/\s+/g, " ").trim();
const sorted = (values: string[]) => [...values].sort();

export function protectedItems(markdown: string): ProtectedItems {
  const anchors = [...markdown.matchAll(anchorPattern)].map((match) => match[1] as string);
  let rest = markdown.replace(anchorPattern, " ");
  const math: string[] = [];
  rest = rest.replace(displayMath, (match) => {
    math.push(squash(match));
    return " ";
  });
  rest = rest.replace(inlineMath, (match) => {
    math.push(squash(match));
    return " ";
  });
  const citations = (rest.match(citationPattern) ?? []).map((entry) =>
    entry.startsWith("[") ? squash(entry) : entry.replace(/[.:-]+$/, ""),
  );
  const labels = (rest.match(labelPattern) ?? []).map(squash);
  const targets = [...rest.matchAll(targetPattern)].map((match) => match[1] as string);
  const footnotes = rest.match(footnotePattern) ?? [];
  const prose = rest
    .replace(citationPattern, " ")
    .replace(labelPattern, " ")
    .replace(targetPattern, "] ")
    .replace(footnotePattern, " ");
  const numbers = prose.match(numberPattern) ?? [];
  return { citations, anchors, numbers, labels, math, targets, footnotes };
}

function multisetDiff(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const item of before) counts.set(item, (counts.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of after) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else added.push(item);
  }
  const removed: string[] = [];
  for (const [item, count] of counts)
    for (let index = 0; index < count; index += 1) removed.push(item);
  return { removed, added };
}

const shown = (items: string[]) =>
  items
    .slice(0, 4)
    .map((item) => JSON.stringify(item.length > 50 ? `${item.slice(0, 50)}...` : item))
    .join(", ") + (items.length > 4 ? ", ..." : "");

/** Human-readable violations; empty when nothing protected changed. */
export function diffProtected(before: string, after: string): string[] {
  const a = protectedItems(before);
  const b = protectedItems(after);
  const violations: string[] = [];
  const unordered: [keyof ProtectedItems, string][] = [
    ["citations", "citations or cross-references"],
    ["numbers", "numbers"],
    ["labels", "labels"],
    ["targets", "link or image targets"],
    ["footnotes", "footnote marks"],
  ];
  for (const [key, name] of unordered) {
    const { removed, added } = multisetDiff(sorted(a[key]), sorted(b[key]));
    if (removed.length === 0 && added.length === 0) continue;
    violations.push(
      `The edit changed ${name}${removed.length ? `; removed ${shown(removed)}` : ""}${added.length ? `; added ${shown(added)}` : ""}`,
    );
  }
  const ordered: [keyof ProtectedItems, string][] = [
    ["anchors", "claim anchors"],
    ["math", "math"],
  ];
  for (const [key, name] of ordered) {
    if (a[key].length === b[key].length && a[key].every((item, index) => item === b[key][index]))
      continue;
    const { removed, added } = multisetDiff(a[key], b[key]);
    violations.push(
      `The edit changed ${name}${removed.length ? `; removed ${shown(removed)}` : ""}${added.length ? `; added ${shown(added)}` : ""}${removed.length === 0 && added.length === 0 ? "; the order changed" : ""}`,
    );
  }
  return violations;
}
