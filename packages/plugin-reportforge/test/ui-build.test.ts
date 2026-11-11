import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain build script without declarations
import { buildUi, inlineIcon, writeUi } from "../scripts/copy-ui.mjs";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("studio frame build", () => {
  it("inlines the real icon in the brand, decorative and without the old glyph", async () => {
    const out = await mkdtemp(join(tmpdir(), "rf-ui-"));
    try {
      const target = await writeUi(pathToFileURL(`${out}/`));
      const html = await readFile(target, "utf8");
      const svg = await read("icon.svg");
      const shapes = svg.match(/<(path|rect)\b[^>]*\/>/g) ?? [];
      expect(shapes.length).toBeGreaterThan(5);
      for (const shape of shapes) expect(html).toContain(shape);
      expect(html).not.toContain("◈");
      expect(html).not.toContain("<!--rf-icon-->");
      const brand = html.match(/<div class="brand">[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(brand).toMatch(/<span class="logo" aria-hidden="true"><svg[^>]*aria-hidden="true"/);
      expect(brand).toContain("Report<b>Forge</b>");
      expect(brand).not.toContain("<title");
      expect(html).not.toMatch(/<link[^>]+rel="icon"/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("prefixes ids so the inline icon cannot collide with the page", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" role="img" aria-labelledby="t"><title id="t">x</title><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>';
    const out = inlineIcon(svg);
    expect(out).toContain('id="rf-brand-g"');
    expect(out).toContain("url(#rf-brand-g)");
    expect(out).toContain('href="#rf-brand-g"');
    expect(out).not.toMatch(/\bid="g"|width="512"|role=|aria-labelledby|<title/);
    expect(out).toMatch(/^<svg[^>]* width="30" height="30" aria-hidden="true" focusable="false">/);
  });

  it("fails the build when the slot is missing", () => {
    expect(() => buildUi("<html></html>", "<svg></svg>")).toThrow("slot");
  });
});
