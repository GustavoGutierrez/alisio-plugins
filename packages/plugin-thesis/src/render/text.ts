import type { Block, Inline } from "./model.js";

/** Plain prose of a block tree for the language and writing checks (spec 9.2, G7). */

export interface TextParagraph {
  text: string;
  line?: number;
  /** Headings are prose too, but they are not sentences. */
  heading: boolean;
}

function inlineText(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "emph":
      case "strong":
      case "link":
        out += inlineText(node.children);
        break;
      case "break":
        out += " ";
        break;
      default:
        // Code, math, citations, cross-references and footnote marks are not prose.
        out += " ";
        break;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Every paragraph, heading, list item, quote and table cell, in reading order. */
export function proseOf(blocks: readonly Block[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      const line = block.line === undefined ? {} : { line: block.line };
      switch (block.kind) {
        case "paragraph":
          out.push({ text: inlineText(block.children), heading: false, ...line });
          break;
        case "heading":
          out.push({ text: inlineText(block.children), heading: true, ...line });
          break;
        case "list":
          for (const item of block.items) visit(item);
          break;
        case "quote":
          visit(block.children);
          break;
        case "table":
          for (const row of [block.header, ...block.rows])
            for (const cell of row) out.push({ text: inlineText(cell), heading: false, ...line });
          if (block.caption) out.push({ text: inlineText(block.caption), heading: false, ...line });
          break;
        case "figure":
          out.push({ text: inlineText(block.caption), heading: false, ...line });
          break;
        default:
          break;
      }
    }
  };
  visit(blocks);
  return out.filter((paragraph) => paragraph.text.length > 0);
}

const wordPattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export const wordsOf = (text: string): string[] => text.match(wordPattern) ?? [];
export const countWords = (text: string): number => wordsOf(text).length;
