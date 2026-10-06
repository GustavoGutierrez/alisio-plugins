import { positionIndex } from "./positions.js";

export type SfcKind = "vue" | "svelte" | "astro" | "html";

export interface SfcBlock {
  kind: "script" | "style" | "template" | "frontmatter";
  attrs: Record<string, string | true>;
  lang?: string;
  content: string;
  /** Offset range of `content` inside the source. */
  start: number;
  end: number;
  /** Offset range of the whole block including its tags or fences. */
  outerStart: number;
  outerEnd: number;
  /** 1-based line and column where `content` begins. */
  startLine: number;
  startColumn: number;
}

export interface SfcScan {
  blocks: SfcBlock[];
  errors: string[];
}

function parseAttrs(raw: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  for (const match of raw.matchAll(
    /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    const name = match[1] as string;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? true;
  }
  return attrs;
}

/**
 * Find the top-level blocks of a Vue, Svelte or Astro file. `<script>` and `<style>` bodies are
 * raw text; a Vue `<template>` is matched with nesting so inner `<template v-if>` is kept.
 */
export function extractSfc(source: string, kind: SfcKind): SfcScan {
  const blocks: SfcBlock[] = [];
  const errors: string[] = [];
  const position = positionIndex(source);
  let index = 0;

  if (kind === "astro") {
    const fence = /^\s*---[ \t]*\r?\n/.exec(source);
    if (fence) {
      const contentStart = fence[0].length;
      const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(contentStart - 1));
      if (close) {
        const end = contentStart - 1 + close.index;
        const at = position(contentStart);
        blocks.push({
          kind: "frontmatter",
          attrs: {},
          lang: "ts",
          content: source.slice(contentStart, end + 1),
          start: contentStart,
          end: end + 1,
          outerStart: 0,
          outerEnd: end + close[0].length,
          startLine: at.line,
          startColumn: at.column,
        });
        index = end + close[0].length;
      } else errors.push("Unterminated frontmatter fence");
    }
  }

  const open = /<(script|style|template)\b([^>]*)>/gi;
  open.lastIndex = index;
  for (;;) {
    const match = open.exec(source);
    if (!match) break;
    const name = (match[1] as string).toLowerCase() as "script" | "style" | "template";
    if (name === "template" && kind !== "vue") continue;
    const contentStart = match.index + match[0].length;
    let end = -1;
    if (name === "template") {
      let depth = 1;
      const tags = /<(\/?)template\b[^>]*>/gi;
      tags.lastIndex = contentStart;
      for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
        depth += tag[1] === "/" ? -1 : tag[0].endsWith("/>") ? 0 : 1;
        if (depth === 0) {
          end = tag.index;
          break;
        }
      }
    } else {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(source.slice(contentStart));
      if (close) end = contentStart + close.index;
    }
    if (end === -1) {
      errors.push(`Unclosed <${name}> block at line ${position(match.index).line}`);
      break;
    }
    const attrs = parseAttrs(match[2] as string);
    const at = position(contentStart);
    const lang = typeof attrs.lang === "string" ? attrs.lang : undefined;
    const block: SfcBlock = {
      kind: name,
      attrs,
      ...(lang ? { lang } : {}),
      content: source.slice(contentStart, end),
      start: contentStart,
      end,
      outerStart: match.index,
      outerEnd: end,
      startLine: at.line,
      startColumn: at.column,
    };
    blocks.push(block);
    const closeTag = /<\/[a-z]+\s*>/i.exec(source.slice(end));
    const outerEnd = end + (closeTag ? closeTag[0].length : 0);
    block.outerStart = match.index;
    block.outerEnd = outerEnd;
    open.lastIndex = outerEnd;
  }
  return { blocks, errors };
}

/**
 * Copy of `source` where everything outside the chosen blocks is blanked (newlines kept), so a
 * parser run over it reports positions that match the original file.
 */
export function maskedSource(source: string, keep: readonly SfcBlock[]): string {
  // Offsets are UTF-16 indices; iterate by code unit to stay aligned with `block.start`.
  const kept = new Array<boolean>(source.length).fill(false);
  let masked = "";
  for (const block of keep) for (let i = block.start; i < block.end; i += 1) kept[i] = true;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    masked += kept[i] || char === "\n" || char === "\r" ? char : " ";
  }
  return masked;
}

/** Copy of `source` with the given blocks (tags included) blanked and newlines kept. */
export function withoutBlocks(source: string, blocks: readonly SfcBlock[]): string {
  const blank = new Array<boolean>(source.length).fill(false);
  for (const block of blocks)
    for (let i = block.outerStart; i < block.outerEnd && i < source.length; i += 1) blank[i] = true;
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    out += blank[i] && char !== "\n" && char !== "\r" ? " " : char;
  }
  return out;
}

/** Copy of `source` where only `[start, end)` is kept; positions are preserved. */
export function maskedRange(source: string, start: number, end: number): string {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    out += (i >= start && i < end) || char === "\n" || char === "\r" ? char : " ";
  }
  return out;
}
