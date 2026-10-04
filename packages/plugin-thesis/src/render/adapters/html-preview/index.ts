import { mkdir } from "node:fs/promises";
import { emitHtml } from "../../html/emitter.js";
import { readKatexCss, stageHtml } from "../../html/stage.js";
import type { ThesisDocument } from "../../model.js";
import { outputName } from "../../output-name.js";
import type {
  Availability,
  RenderContext,
  Renderer,
  RendererCapabilities,
  RenderOptions,
  RenderResult,
} from "../../port.js";

/**
 * HTML preview (spec 10.7, `/thesis:build --html`): the standalone document and its assets in the
 * build directory. It needs no browser; opened in one, Paged.js paginates it. It imports nothing
 * from the other adapters.
 */
export const htmlPreviewRenderer: Renderer = {
  id: "html-preview",
  format: "html",

  capabilities(): RendererCapabilities {
    return {
      math: "native",
      mermaid: "native",
      footnotes: "native",
      toc: "native",
      crossrefs: "native",
      bibliography: "converted",
      pdfa: false,
      extension: "html",
    };
  },

  async available(): Promise<Availability> {
    return { available: true, engine: "html", source: "built-in" };
  },

  async render(
    doc: ThesisDocument,
    options: RenderOptions,
    context: RenderContext,
  ): Promise<RenderResult> {
    const started = Date.now();
    const emitted = emitHtml(doc, { katexCss: await readKatexCss() });
    if (emitted.findings.some((finding) => finding.severity === "error")) {
      return {
        ok: false,
        engine: "html-preview",
        ms: Date.now() - started,
        findings: emitted.findings,
        unrepresented: [],
      };
    }
    await mkdir(context.buildDir, { recursive: true, mode: 0o700 });
    const output = outputName(options, "html");
    await stageHtml(emitted.html, context.buildDir, output, { mermaid: emitted.hasMermaid });
    const findings = [...emitted.findings];
    if (options.pdfa) {
      findings.push({
        code: "BLD-004",
        gate: "G8",
        severity: "warning",
        message: "PDF/A does not apply to the HTML preview",
      });
    }
    return {
      ok: true,
      engine: "html-preview",
      output,
      ms: Date.now() - started,
      findings,
      unrepresented: [],
    };
  },
};
