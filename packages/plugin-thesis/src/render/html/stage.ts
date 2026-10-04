import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packagePath } from "../../package-paths.js";
import { atomicWrite } from "../../storage.js";
import { htmlAssetDir } from "./emitter.js";

/** Vendored browser assets (spec 10.7): Paged.js, KaTeX stylesheet and fonts, Mermaid. */
export const vendorDir = (...segments: string[]): string =>
  packagePath("templates", "html", "vendor", ...segments);

export const readKatexCss = (): Promise<string> =>
  readFile(vendorDir("katex", "katex.min.css"), "utf8");

/**
 * Write the HTML and its assets into the build directory: the document next to `_html/`, which holds
 * the runtime, Paged.js, the KaTeX fonts and, when the thesis has diagrams, Mermaid. Returns the
 * absolute path of the HTML file.
 */
export async function stageHtml(
  html: string,
  buildDir: string,
  fileName: string,
  options: { mermaid: boolean },
): Promise<string> {
  const assets = join(buildDir, htmlAssetDir);
  const fonts = join(assets, "fonts");
  await mkdir(fonts, { recursive: true, mode: 0o700 });
  await copyFile(packagePath("templates", "html", "runtime.js"), join(assets, "runtime.js"));
  await copyFile(
    vendorDir("pagedjs", "paged.polyfill.min.js"),
    join(assets, "paged.polyfill.min.js"),
  );
  if (options.mermaid)
    await copyFile(vendorDir("mermaid", "mermaid.min.js"), join(assets, "mermaid.min.js"));
  for (const name of await readdir(vendorDir("katex", "fonts"))) {
    if (name.endsWith(".woff2"))
      await copyFile(vendorDir("katex", "fonts", name), join(fonts, name));
  }
  const target = join(buildDir, fileName);
  await atomicWrite(target, html);
  return target;
}
