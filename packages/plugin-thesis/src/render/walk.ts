import type { Block, Inline, ThesisDocument } from "./model.js";

/** Visit every inline of a block tree, with the block that owns it (for line numbers). */
export function walkInlines(
  blocks: readonly Block[],
  visit: (inline: Inline, owner: Block) => void,
): void {
  const inlines = (nodes: readonly Inline[], owner: Block) => {
    for (const node of nodes) {
      visit(node, owner);
      if (node.kind === "emph" || node.kind === "strong" || node.kind === "link")
        inlines(node.children, owner);
    }
  };
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        inlines(block.children, block);
        break;
      case "list":
        for (const item of block.items) walkInlines(item, visit);
        break;
      case "quote":
        walkInlines(block.children, visit);
        break;
      case "table":
        for (const cell of block.header) inlines(cell, block);
        for (const row of block.rows) for (const cell of row) inlines(cell, block);
        if (block.caption) inlines(block.caption, block);
        if (block.source) inlines(block.source, block);
        break;
      case "figure":
        inlines(block.caption, block);
        if (block.source) inlines(block.source, block);
        break;
      default:
        break;
    }
  }
}

/** Every block, depth first, including list items, quotes and footnote bodies. */
export function walkBlocks(blocks: readonly Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.kind === "list") for (const item of block.items) walkBlocks(item, visit);
    if (block.kind === "quote") walkBlocks(block.children, visit);
  }
}

/** All sections of a document in reading order, with file context. */
export function allSections(doc: ThesisDocument) {
  return [...doc.frontMatter, ...doc.body, ...doc.annexes];
}

/** All block trees of a document including footnote bodies (footnote ids are `<file>#<n>`). */
export function allBlockLists(doc: ThesisDocument): { file?: string; blocks: Block[] }[] {
  return [
    ...allSections(doc).map((section) => ({ file: section.path, blocks: section.blocks })),
    ...Object.entries(doc.footnotes).map(([id, blocks]) => ({
      file: id.slice(0, id.lastIndexOf("#")),
      blocks,
    })),
  ];
}
