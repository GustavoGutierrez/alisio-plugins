import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectChrome } from "../../../chrome/detect.js";
import type { Finding } from "../../../types.js";
import { emitHtml } from "../../html/emitter.js";
import { readKatexCss, stageHtml } from "../../html/stage.js";
import type { ThesisDocument } from "../../model.js";
import { outputName } from "../../output-name.js";
import type {
  Availability,
  RenderContext,
  RenderEnvironment,
  Renderer,
  RendererCapabilities,
  RenderOptions,
  RenderResult,
} from "../../port.js";
import { CdpError, type CdpTransport, printToPdf } from "./cdp.js";

export { chromeArgs, printToPdf } from "./cdp.js";
export { isRequestAllowed } from "./network.js";

const hint =
  "Install Google Chrome or Chromium, set ALISIO_THESIS_CHROME, or run /thesis:setup for Typst.";

async function chromeAvailability(env: NodeJS.ProcessEnv): Promise<Availability> {
  const detection = await detectChrome({ env });
  if (!detection.browser) {
    return {
      available: false,
      reason: "No Chrome-family browser was found for the PDF fallback",
      hint,
    };
  }
  return {
    available: true,
    engine: "chrome",
    source: detection.source ?? "path",
    path: detection.browser,
  };
}

const error = (message: string, extra?: string): Finding => ({
  code: "BLD-001",
  gate: "G8",
  severity: "error",
  message,
  ...(extra ? { hint: extra } : {}),
});

/**
 * PDF through headless Chrome and Paged.js (spec 10.7): the fallback when no Typst engine is
 * available. It shares the HTML emitter with the HTML preview and imports nothing from the other
 * adapters.
 */
export const chromePdfRenderer: Renderer = {
  id: "chrome-pdf",
  format: "pdf",

  capabilities(): RendererCapabilities {
    return {
      math: "native",
      mermaid: "native",
      footnotes: "native",
      toc: "native",
      crossrefs: "native",
      // Citations and the bibliography use built-in formatters, not the CSL file.
      bibliography: "converted",
      pdfa: false,
      extension: "pdf",
    };
  },

  available(env: RenderEnvironment): Promise<Availability> {
    return chromeAvailability(env.env);
  },

  async render(
    doc: ThesisDocument,
    options: RenderOptions,
    context: RenderContext,
  ): Promise<RenderResult> {
    const started = Date.now();
    const fail = (findings: Finding[], engine = "chrome-pdf"): RenderResult => ({
      ok: false,
      engine,
      ms: Date.now() - started,
      findings,
      unrepresented: [],
    });
    if (options.pdfa) {
      return fail([
        error(
          "PDF/A output needs the Typst engine; the Chrome fallback cannot produce it",
          "Run /thesis:setup to install the pinned Typst.",
        ),
      ]);
    }
    const emitted = emitHtml(doc, { katexCss: await readKatexCss() });
    if (emitted.findings.some((finding) => finding.severity === "error")) {
      return fail(emitted.findings);
    }
    const availability = await chromeAvailability(context.env);
    if (!availability.available) {
      return fail([...emitted.findings, error(availability.reason, availability.hint)]);
    }

    await mkdir(context.buildDir, { recursive: true, mode: 0o700 });
    const output = outputName(options, "pdf");
    const htmlName = outputName(options, "html");
    const htmlPath = await stageHtml(emitted.html, context.buildDir, htmlName, {
      mermaid: emitted.hasMermaid,
    });
    context.progress?.("chrome: paginating and printing");
    const transport = (
      context.env.ALISIO_THESIS_CDP === "websocket" ? "websocket" : "pipe"
    ) as CdpTransport;
    try {
      const printed = await printToPdf({
        chrome: availability.path as string,
        htmlPath,
        buildDir: context.buildDir,
        env: context.env,
        transport,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      await writeFile(join(context.buildDir, output), printed.pdf, { mode: 0o600 });
      const findings = [...emitted.findings];
      if (printed.blockedRequests.length > 0) {
        findings.push({
          code: "BLD-004",
          gate: "G8",
          severity: "warning",
          message: `${printed.blockedRequests.length} network request(s) from the page were blocked`,
          hint: printed.blockedRequests.slice(0, 3).join(", "),
        });
      }
      for (const text of printed.consoleErrors.slice(0, 3)) {
        findings.push({
          code: "BLD-003",
          gate: "G8",
          severity: "warning",
          message: `Chrome console: ${text}`,
        });
      }
      return {
        ok: true,
        engine: `chrome-pdf (${printed.product})`,
        output,
        pages: printed.pages,
        ms: Date.now() - started,
        findings,
        unrepresented: [],
      };
    } catch (caught) {
      const failure =
        caught instanceof CdpError
          ? caught
          : new CdpError(caught instanceof Error ? caught.message : String(caught));
      return fail([
        ...emitted.findings,
        error(
          `Chrome could not produce the PDF: ${failure.message}`,
          failure.kind === "timeout"
            ? "Try the Typst engine (/thesis:setup) for large documents."
            : undefined,
        ),
      ]);
    }
  },
};
