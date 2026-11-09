// Writes the self-contained guide page to dist/embedded.html. The plugin injects the catalog data
// at serve time (marker __FREE_MODELS_DATA__), so the page has one source of truth: src/catalog.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { buildEmbeddedHtml } from "./embedded-html.mjs";

const out = new URL("../dist/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("embedded.html", out), await buildEmbeddedHtml());
