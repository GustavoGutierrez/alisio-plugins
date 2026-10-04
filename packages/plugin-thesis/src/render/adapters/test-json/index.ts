import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../../storage.js";
import type { Block, ThesisDocument } from "../../model.js";
import type {
  Availability,
  RenderContext,
  Renderer,
  RendererCapabilities,
  RenderOptions,
  RenderResult,
} from "../../port.js";
import { allSections, walkBlocks } from "../../walk.js";

/**
 * A renderer that writes the document model as JSON. It is registered only in tests: it proves the
 * port carries everything an output format needs without any Typst-specific type. It imports
 * nothing from the other adapters.
 */
export const testJsonRenderer: Renderer = {
  id: "test-json",
  format: "json",

  capabilities(): RendererCapabilities {
    return {
      math: "none",
      mermaid: "none",
      footnotes: "native",
      toc: "none",
      crossrefs: "native",
      bibliography: "none",
      pdfa: false,
      extension: "json",
    };
  },

  async available(): Promise<Availability> {
    return { available: true, engine: "test-json", source: "built-in" };
  },

  async render(
    doc: ThesisDocument,
    options: RenderOptions,
    context: RenderContext,
  ): Promise<RenderResult> {
    const started = Date.now();
    const counts: Record<string, number> = {};
    const count = (block: Block) => {
      counts[block.kind] = (counts[block.kind] ?? 0) + 1;
    };
    for (const section of allSections(doc)) walkBlocks(section.blocks, count);
    const output = {
      scope: options.scope,
      meta: doc.meta,
      frontMatter: doc.frontMatter,
      body: doc.body,
      annexes: doc.annexes,
      footnotes: doc.footnotes,
      figures: Object.fromEntries(doc.figures),
      bibliography: {
        styleId: doc.bibliography.styleId,
        keys: doc.bibliography.entries.map((entry) => entry.citeKey),
      },
      counts,
    };
    await mkdir(context.buildDir, { recursive: true, mode: 0o700 });
    await atomicWrite(
      join(context.buildDir, "thesis.json"),
      `${JSON.stringify(output, null, 2)}\n`,
    );
    return {
      ok: true,
      engine: "test-json",
      output: "thesis.json",
      ms: Date.now() - started,
      findings: [],
      unrepresented: [],
    };
  },
};
