// Bundles web/ (app, i18n, derive, icons, markdown, copy, styles and the PDF.js viewer) into one
// self-contained HTML document for the Alisio plugin apps frame: inline styles and one inline
// script carrying the host nonce marker.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Placeholder the host replaces with a fresh CSP nonce per frame request. */
export const NONCE_MARKER = "__ALISIO_NONCE__";

/** Plain browser modules, in dependency order (they share one function scope). */
export const MODULES = ["i18n.js", "derive.js", "icons.js", "markdown.js", "copy.js"];

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");

export async function buildEmbeddedHtml() {
  const viewer = await build({
    entryPoints: [fileURLToPath(new URL("../web/pdf-viewer.js", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
    legalComments: "none",
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
  // Drop the modules' `export` keywords and the app's `import` lines: every module the app
  // imports is inlined here, in dependency order.
  const modules = [];
  for (const name of MODULES) modules.push((await read(name)).replace(/^export /gm, ""));
  const app = (await read("app.js")).replace(/^import [\s\S]*?;\n/gm, "");
  const js =
    `${viewer.outputFiles[0].text}\n(async()=>{${modules.join("\n")}\n${app}\n})();`.replaceAll(
      "</script",
      "<\\/script",
    );
  const icon = await readFile(new URL("../icon.svg", import.meta.url));
  const css = `:root{--thesis-icon:url("data:image/svg+xml;base64,${icon.toString("base64")}")}\n${await read("style.css")}`;
  return (await read("index.html"))
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      () => `<script nonce="${NONCE_MARKER}">${js}</script>`,
    );
}
