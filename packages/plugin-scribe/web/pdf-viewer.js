import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs";

GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([worker], { type: "text/javascript" }),
);
let generation = 0;
// The frame CSP forbids WASM and eval: PDF.js runs its JavaScript decoders only, and the
// worker is a blob: URL (worker-src blob:). The PDF arrives as a Blob, so nothing is fetched.
globalThis.scribeRenderPdf = async (holder, blob) => {
  const version = ++generation;
  holder.replaceChildren();
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const pdf = await getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
      useWasm: false,
      useWorkerFetch: false,
      enableXfa: false,
    }).promise;
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        if (version !== generation) return;
        const page = await pdf.getPage(i);
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, Math.max(0.5, (holder.clientWidth - 24) / natural.width)),
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.cssText = "display:block;max-width:100%;margin:12px auto;background:white";
        holder.append(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
    } finally {
      await pdf.destroy();
    }
  } catch {
    holder.textContent =
      document.documentElement.lang === "es"
        ? "No se pudo mostrar el PDF. Puedes descargarlo."
        : "Could not display the PDF. You can download it.";
  }
};
