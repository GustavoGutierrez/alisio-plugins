// PDF preview for the Evalua frame (Scribe's viewer), bundled by esbuild. The frame CSP forbids
// WASM and eval: PDF.js runs its JavaScript decoders only and its worker starts from a blob: URL.
// The PDF arrives as a Blob from an action, so nothing is fetched.
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs";

GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([worker], { type: "text/javascript" }),
);
let generation = 0;

// `options.pageLabel(i, n)` gives each page its text alternative ("Page 2 of 3");
// `options.onInfo({ pages })` runs once the page count is known; `options.failed` is the message
// shown when the PDF cannot be displayed.
globalThis.evaluaRenderPdf = async (holder, blob, options = {}) => {
  const version = ++generation;
  holder.replaceChildren();
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const task = getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
      useWasm: false,
      useWorkerFetch: false,
      enableXfa: false,
    });
    const pdf = await task.promise;
    try {
      options.onInfo?.({ pages: pdf.numPages });
      for (let i = 1; i <= pdf.numPages; i++) {
        if (version !== generation) return;
        const page = await pdf.getPage(i);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(0.4, (holder.clientWidth - 24) / natural.width));
        const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: scale * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.dataset.page = String(i);
        canvas.setAttribute("role", "img");
        canvas.setAttribute(
          "aria-label",
          options.pageLabel ? options.pageLabel(i, pdf.numPages) : `${i} / ${pdf.numPages}`,
        );
        canvas.className = "pdf-page";
        canvas.style.width = `${Math.ceil(viewport.width / ratio)}px`;
        holder.append(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
    } finally {
      // pdfjs 6 releases a document through its loading task (the proxy has no destroy()).
      await task.destroy();
    }
  } catch {
    holder.textContent = options.failed ?? "";
  }
};
