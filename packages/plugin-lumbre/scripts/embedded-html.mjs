// Bundles web/ into one self-contained HTML document for the Alisio plugin apps frame: inline
// styles and one inline script carrying the host nonce marker. The plain browser modules share one
// function scope: their `export` keywords and the app's `import` lines are dropped, and every
// module the app imports is inlined here in dependency order.
import { readFile } from "node:fs/promises";

/** Placeholder the host replaces with a fresh CSP nonce per frame request. */
export const NONCE_MARKER = "__ALISIO_NONCE__";
export const MODULES = [
  "i18n.js",
  "icons.js",
  "markdown.js",
  "copy.js",
  "diff.js",
  "derive.js",
  "thumbnail.js",
];

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");

export async function buildEmbeddedHtml() {
  const modules = [];
  for (const name of MODULES) modules.push((await read(name)).replace(/^export /gm, ""));
  const app = (await read("app.js")).replace(/^import [\s\S]*?;\n/gm, "");
  const js = `(async()=>{${modules.join("\n")}\n${app}\n})();`.replaceAll("</script", "<\\/script");
  const icon = await readFile(new URL("../icon.svg", import.meta.url));
  const css = `:root{--lumbre-icon:url("data:image/svg+xml;base64,${icon.toString("base64")}")}\n${await read("style.css")}`;
  return (await read("index.html"))
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      () => `<script nonce="${NONCE_MARKER}">${js}</script>`,
    );
}
