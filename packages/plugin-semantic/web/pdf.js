// PDF text extraction in the frame (§7.3), bundled by esbuild. The frame CSP forbids WASM and eval:
// PDF.js runs its JavaScript decoders only and its worker starts from a blob: URL.
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs";

GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([worker], { type: "text/javascript" }),
);

/** Text of each page, in order. */
globalThis.semanticPdfPages = async (bytes) => {
  const task = getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
  });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .replace(/[ \t]+\n/g, "\n")
          .trim(),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
};
