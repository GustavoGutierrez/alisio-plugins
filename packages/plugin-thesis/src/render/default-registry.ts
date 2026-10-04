import { chromePdfRenderer } from "./adapters/chrome-pdf/index.js";
import { htmlPreviewRenderer } from "./adapters/html-preview/index.js";
import { typstPdfRenderer } from "./adapters/typst-pdf/index.js";
import { RendererRegistry } from "./registry.js";

/**
 * The renderers shipped with the package, in engine order: Typst first, then the Chrome PDF
 * fallback (spec 10.6), then the HTML preview. Test-only adapters are added by the tests themselves.
 */
export function createDefaultRegistry(): RendererRegistry {
  return new RendererRegistry()
    .register(typstPdfRenderer)
    .register(chromePdfRenderer)
    .register(htmlPreviewRenderer);
}
