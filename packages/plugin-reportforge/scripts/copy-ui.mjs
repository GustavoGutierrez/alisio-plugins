// Builds the studio frame into dist/, where the plugin reads it at runtime (`./ui.html`).
// The brand mark is the package's own icon.svg, inlined at build time so the frame stays a single
// self-contained file (no request, nothing for the host CSP to allow) and icon.svg stays the only
// copy of the artwork.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const SLOT = "<!--rf-icon-->";
const PREFIX = "rf-brand-";

/** icon.svg as a decorative 30 px inline mark: no title/desc, ids prefixed so they never collide. */
export function inlineIcon(svg) {
  let out = svg
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<title\b[\s\S]*?<\/title>/g, "")
    .replace(/<desc\b[\s\S]*?<\/desc>/g, "");
  for (const [, id] of out.matchAll(/\bid="([^"]+)"/g)) {
    out = out
      .replaceAll(`id="${id}"`, `id="${PREFIX}${id}"`)
      .replaceAll(`url(#${id})`, `url(#${PREFIX}${id})`)
      .replaceAll(`href="#${id}"`, `href="#${PREFIX}${id}"`);
  }
  out = out.replace(/<svg\b([^>]*)>/, (_match, attrs) => {
    const kept = attrs.replace(/\s(width|height|role|aria-[a-z]+|focusable)="[^"]*"/g, "");
    return `<svg${kept} width="30" height="30" aria-hidden="true" focusable="false">`;
  });
  return out.trim().replace(/>\s+</g, "><");
}

/** The frame with the icon in its brand slot. Fails loudly if the slot or icon is missing. */
export function buildUi(html, svg) {
  if (!html.includes(SLOT)) throw new Error("ui/index.html has no brand icon slot");
  if (!/<svg\b/.test(svg)) throw new Error("icon.svg is not an SVG");
  return html.replace(SLOT, inlineIcon(svg));
}

/** Writes `<outDir>/ui.html` from ui/index.html and icon.svg. */
export async function writeUi(outDir = new URL("dist/", root)) {
  const [html, svg] = await Promise.all([
    readFile(new URL("ui/index.html", root), "utf8"),
    readFile(new URL("icon.svg", root), "utf8"),
  ]);
  await mkdir(outDir, { recursive: true });
  const target = new URL("ui.html", outDir.href.endsWith("/") ? outDir : `${outDir.href}/`);
  await writeFile(target, buildUi(html, svg));
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await writeUi();
