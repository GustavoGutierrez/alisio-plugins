// Bundles web/ (app, i18n, styles and the PDF.js viewer) into one self-contained HTML document for
// the Alisio plugin apps frame: inline styles, one inline script carrying the host nonce marker.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Placeholder the host replaces with a fresh CSP nonce per frame request. */
export const NONCE_MARKER = "__ALISIO_NONCE__";

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");

export async function buildEmbeddedHtml() {
  const viewer = await build({
    entryPoints: [fileURLToPath(new URL("../web/pdf-viewer.js", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
    plugins: [
      {
        name: "worker-text",
        setup(b) {
          b.onLoad({ filter: /pdf\.worker\.min\.mjs$/ }, async (args) => ({
            contents: await readFile(args.path, "utf8"),
            loader: "text",
          }));
        },
      },
    ],
  });
  const i18n = (await read("i18n.js")).replace(/^export /gm, "");
  const app = (await read("app.js")).replace(/^import .*?;\n/, "");
  const js = `${viewer.outputFiles[0].text}\n(async()=>{${i18n}\n${app}\n})();`.replaceAll(
    "</script",
    "<\\/script",
  );
  const css = await read("style.css");
  return (await read("index.html"))
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      () => `<script nonce="${NONCE_MARKER}">${js}</script>`,
    );
}
