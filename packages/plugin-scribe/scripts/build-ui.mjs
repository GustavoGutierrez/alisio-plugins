// Writes the self-contained studio page to dist/embedded.html, which the plugin serves through the
// Alisio plugin apps API.
import { mkdir, writeFile } from "node:fs/promises";
import { buildEmbeddedHtml } from "./embedded-html.mjs";

const out = new URL("../dist/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("embedded.html", out), await buildEmbeddedHtml());
