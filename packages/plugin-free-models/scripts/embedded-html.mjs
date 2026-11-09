// Inlines web/style.css and web/app.js into web/index.html: one inline script carrying the host
// nonce marker, no external references.
import { readFile } from "node:fs/promises";

/** Placeholder the host replaces with a fresh CSP nonce per frame request. */
export const NONCE_MARKER = "__ALISIO_NONCE__";

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");

export async function buildEmbeddedHtml() {
  const js = (await read("app.js")).replaceAll("</script", "<\\/script");
  const css = await read("style.css");
  return (await read("index.html"))
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      () => `<script nonce="${NONCE_MARKER}">(()=>{${js}\n})();</script>`,
    );
}
