import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";
import { idPatterns } from "../types.js";
import type { LabelKind } from "./model.js";

/**
 * Markdown dialect extensions (spec 10.2) as a markdown-it plugin: inline math, bracketed and
 * narrative citations, cross-references and display math with an optional `{#eq-x}` label.
 * Everything else (labels on headings, figure attributes, table captions, claim anchors) is read
 * from the token stream by `parse.ts`.
 */

export const labelPattern = /^(fig|tbl|eq|sec)-[a-z0-9-]{1,48}$/;

/** Narrative citation keys: author + year + optional disambiguator (spec 4.1). */
export const citeKeyPattern = idPatterns.citationKey;

const keyChars = /[A-Za-z0-9_:.-]/;
const wordChar = /[\p{L}\p{N}_]/u;

export interface LabelAttrs {
  label?: string;
  width?: string;
  /** Attribute fragments that are not part of the dialect. */
  unknown: string[];
}

const widthPattern = /^\d{1,3}(?:\.\d+)?%$|^\d{1,3}(?:\.\d+)?(?:cm|mm|in|pt)$/;

/** Parse the inside of `{#label width=80%}`; anything unrecognized is reported, never dropped. */
export function parseAttrs(body: string): LabelAttrs {
  const attrs: LabelAttrs = { unknown: [] };
  for (const part of body.trim().split(/\s+/).filter(Boolean)) {
    if (part.startsWith("#") && labelPattern.test(part.slice(1)) && attrs.label === undefined) {
      attrs.label = part.slice(1);
    } else if (part.startsWith("width=") && widthPattern.test(part.slice(6))) {
      attrs.width = part.slice(6);
    } else {
      attrs.unknown.push(part);
    }
  }
  return attrs;
}

export function labelKind(label: string): LabelKind {
  return label.slice(0, label.indexOf("-")) as LabelKind;
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24) return false;
  const first = src[start + 1];
  if (first === undefined || first === "$" || /\s/.test(first)) return false;
  let end = start + 1;
  for (;;) {
    end = src.indexOf("$", end);
    if (end === -1 || end >= state.posMax) return false;
    // Count preceding backslashes: an odd number escapes the dollar sign.
    let slashes = 0;
    while (src[end - 1 - slashes] === "\\") slashes += 1;
    const next = src[end + 1];
    if (
      slashes % 2 === 0 &&
      !/\s/.test(src[end - 1] ?? " ") &&
      !(next !== undefined && /\d/.test(next))
    ) {
      break;
    }
    end += 1;
  }
  const content = src.slice(start + 1, end);
  if (content.includes("\n\n")) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = content.replace(/\s*\n\s*/g, " ");
  }
  state.pos = end + 1;
  return true;
}

interface CiteItem {
  key: string;
  locator?: string;
}

function parseCitation(body: string): CiteItem[] | undefined {
  const items: CiteItem[] = [];
  for (const raw of body.split(";")) {
    const match = /^\s*@([A-Za-z0-9_](?:[A-Za-z0-9_:.-]*[A-Za-z0-9_])?)(?:\s*,\s*(.+?))?\s*$/s.exec(
      raw,
    );
    if (!match) return undefined;
    const locator = match[2]?.trim();
    if (locator !== undefined && (locator.length > 80 || /[[\]\n]/.test(locator))) return undefined;
    items.push(locator ? { key: match[1] as string, locator } : { key: match[1] as string });
  }
  return items.length > 0 ? items : undefined;
}

function bracketCitation(state: StateInline, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x40) return false;
  const end = src.indexOf("]", start);
  if (end === -1 || end >= state.posMax) return false;
  const items = parseCitation(src.slice(start + 1, end));
  if (!items) return false;
  if (!silent) {
    const token = state.push("thesis_cite", "", 0);
    token.meta = { items, narrative: false };
  }
  state.pos = end + 1;
  return true;
}

function atReference(state: StateInline, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x40) return false;
  const before = src[start - 1];
  // `user@example.org` is an address, not a reference.
  if (before !== undefined && wordChar.test(before)) return false;
  let end = start + 1;
  while (end < state.posMax && keyChars.test(src[end] as string)) end += 1;
  // Trailing punctuation belongs to the sentence, not the key.
  while (end > start + 1 && /[.:-]/.test(src[end - 1] as string)) end -= 1;
  const word = src.slice(start + 1, end);
  if (word === "") return false;
  const after = src[end];
  if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) return false;
  if (!silent) {
    if (labelPattern.test(word)) {
      const token = state.push("thesis_ref", "", 0);
      token.meta = { label: word, refKind: labelKind(word) };
    } else if (citeKeyPattern.test(word)) {
      const token = state.push("thesis_cite", "", 0);
      token.meta = { items: [{ key: word }], narrative: true };
    } else {
      const token = state.push("thesis_badref", "", 0);
      token.content = `@${word}`;
    }
  }
  state.pos = end;
  return true;
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const pos = (state.bMarks[startLine] as number) + (state.tShift[startLine] as number);
  if ((state.sCount[startLine] as number) - state.blkIndent > 3) return false;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  const lineText = (line: number) =>
    state.src.slice(
      (state.bMarks[line] as number) + (state.tShift[line] as number),
      state.eMarks[line] as number,
    );
  const closing = /\$\$\s*(\{[^}]*\})?\s*$/;

  const first = lineText(startLine).slice(2);
  let attr: string | undefined;
  let nextLine = startLine;
  const body: string[] = [];
  const single = closing.exec(first);
  if (single) {
    attr = single[1];
    body.push(first.slice(0, single.index));
  } else {
    body.push(first);
    for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
      const text = lineText(nextLine);
      const match = closing.exec(text);
      if (match) {
        attr = match[1];
        body.push(text.slice(0, match.index));
        break;
      }
      body.push(text);
    }
    if (nextLine >= endLine) return false;
  }
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = body.join("\n").trim();
  token.map = [startLine, nextLine + 1];
  token.meta = { attr: attr?.slice(1, -1) };
  state.line = nextLine + 1;
  return true;
}

/** markdown-it plugin installing the thesis dialect. */
export function thesisDialect(md: MarkdownIt): void {
  md.inline.ruler.before("escape", "thesis_math", inlineMath);
  md.inline.ruler.before("link", "thesis_cite", bracketCitation);
  md.inline.ruler.before("escape", "thesis_ref", atReference);
  md.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
}
