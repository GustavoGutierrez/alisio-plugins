// Writes the self-contained Lumbre page to dist/embedded.html, served through the plugin apps API.
import { mkdir, writeFile } from "node:fs/promises";
import { buildEmbeddedHtml } from "./embedded-html.mjs";

const out = new URL("../dist/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("embedded.html", out), await buildEmbeddedHtml());
