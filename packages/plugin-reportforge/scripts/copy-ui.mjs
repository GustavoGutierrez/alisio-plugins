// Copies the studio frame into dist/, where the plugin reads it at runtime (`./ui.html`).
import { copyFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await mkdir(new URL("dist/", root), { recursive: true });
await copyFile(new URL("ui/index.html", root), new URL("dist/ui.html", root));
