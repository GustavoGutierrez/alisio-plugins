// Bundles web/ (app, i18n, styles and the PDF.js viewer) into one self-contained HTML document at
// dist/embedded.html, which the plugin serves through the Alisio plugin apps API.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), "utf8");
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
const html = (await read("index.html"))
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
  .replace(
    '<script type="module" src="app.js"></script>',
    () => `<script nonce="__ALISIO_NONCE__">${js}</script>`,
  );
const out = new URL("../dist/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("embedded.html", out), html);
