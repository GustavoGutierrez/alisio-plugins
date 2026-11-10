// PDF preview (from Scribe): PDF.js bundled into the frame, JavaScript decoders only.
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs";

GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([worker], { type: "text/javascript" }),
);
let generation = 0;
// The frame CSP forbids WASM and eval: PDF.js runs its JavaScript decoders only, and the
// worker is a blob: URL (worker-src blob:). The PDF arrives as a Blob, so nothing is fetched.
// `options.zoom` is a scale factor, or "fit" to fit the page to the holder width. `options.onInfo`
// receives `{ pages, scale }` once the page count and the effective scale are known.
globalThis.thesisRenderPdf = async (holder, blob, options = {}) => {
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
      const fit = options.zoom === undefined || options.zoom === "fit";
      for (let i = 1; i <= pdf.numPages; i++) {
        if (version !== generation) return;
        const page = await pdf.getPage(i);
        const natural = page.getViewport({ scale: 1 });
        const scale = fit
          ? Math.min(2, Math.max(0.5, (holder.clientWidth - 32) / natural.width))
          : Number(options.zoom);
        if (i === 1) options.onInfo?.({ pages: pdf.numPages, scale });
        const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: scale * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.dataset.page = String(i);
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `${i} / ${pdf.numPages}`);
        canvas.style.cssText = `display:block;width:${Math.ceil(viewport.width / ratio)}px;${fit ? "max-width:100%;" : ""}margin:0 auto 16px;background:white`;
        holder.append(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
    } finally {
      await task.destroy();
    }
  } catch {
    holder.textContent =
      document.documentElement.lang === "es"
        ? "No se pudo mostrar el PDF. Puedes descargarlo."
        : "Could not display the PDF. You can download it.";
  }
};
