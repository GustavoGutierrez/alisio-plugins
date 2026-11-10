// Bundles web/ (app, i18n, derive, icons, copy, styles, the PDF.js viewer and the vendored KaTeX
// stylesheet with its fonts) into one self-contained HTML document for the Alisio plugin apps
// frame: inline styles and one inline script carrying the host nonce marker. Nothing is fetched.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Placeholder the host replaces with a fresh CSP nonce per frame request. */
export const NONCE_MARKER = "__ALISIO_NONCE__";

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");
const katexDir = new URL("../templates/html/vendor/katex/", import.meta.url);

/** The vendored KaTeX CSS with each woff2 font inlined as a data URI (the woff/ttf ones dropped). */
export async function katexStyles() {
  const css = await readFile(new URL("katex.min.css", katexDir), "utf8");
  const pattern =
    /src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\) format\("woff2"\),url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)/g;
  const fonts = new Map();
  for (const match of css.matchAll(pattern)) {
    const file = match[1];
    if (!fonts.has(file)) {
      const data = await readFile(new URL(`fonts/${file}.woff2`, katexDir));
      fonts.set(file, data.toString("base64"));
    }
  }
  return css.replace(
    pattern,
    (_match, file) => `src:url(data:font/woff2;base64,${fonts.get(file)}) format("woff2")`,
  );
}

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
  // The plain browser modules share one function scope: drop their `export` keywords and the
  // app's `import` lines (every module the app imports is inlined here, in dependency order).
  const modules = [];
  for (const name of ["i18n.js", "derive.js", "icons.js", "copy.js"])
    modules.push((await read(name)).replace(/^export /gm, ""));
  const app = (await read("app.js")).replace(/^import [\s\S]*?;\n/gm, "");
  const js =
    `${viewer.outputFiles[0].text}\n(async()=>{${modules.join("\n")}\n${app}\n})();`.replaceAll(
      "</script",
      "<\\/script",
    );
  const icon = await readFile(new URL("../icon.svg", import.meta.url));
  const css = [
    `:root{--evalua-icon:url("data:image/svg+xml;base64,${icon.toString("base64")}")}`,
    await katexStyles(),
    await read("style.css"),
  ].join("\n");
  return (await read("index.html"))
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      () => `<script nonce="${NONCE_MARKER}">${js}</script>`,
    );
}
