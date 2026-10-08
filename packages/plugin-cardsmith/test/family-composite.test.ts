import { describe, expect, it } from "vitest";
import { paletteToken } from "../src/core/palettes.js";
import type { GroupOp, ImageOp, RectOp, Scene, SceneOp, TextOp } from "../src/core/scene.js";
import { generatorFor } from "../src/generators/index.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { normalizedSpecFor, packagedRegistry, rawSpec } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COMPOSITE_TEMPLATES = ["photo-caption", "watermark", "image-collage"] as const;

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

function imageFixtures(ids: readonly string[]): Array<{ id: string; path: string }> {
  return ids.map((id) => ({ id, path: `test://${id}.png` }));
}

/** Text ops at any depth; watermark tiles live inside rotated groups. */
function collectTextOps(ops: readonly SceneOp[]): TextOp[] {
  const texts: TextOp[] = [];
  for (const op of ops) {
    if (op.op === "text") texts.push(op);
    else if (op.op === "group") texts.push(...collectTextOps(op.children));
  }
  return texts;
}

function firstTextIndex(scene: Scene): number {
  return scene.ops.findIndex((op) => op.op === "text");
}

describe("composite generator", () => {
  it("composes and renders every composite template deterministically", async () => {
    const generator = generatorFor("composite");
    for (const templateId of COMPOSITE_TEMPLATES) {
      const content =
        templateId === "watermark"
          ? { watermarkText: "CONFIDENCIAL" }
          : templateId === "photo-caption"
            ? { caption: "Tormenta sobre la bahía", author: "Ana", locationLabel: "Valparaíso" }
            : { title: "Nuestro viaje", caption: "Un fin de semana junto al mar" };
      const spec = normalizedSpecFor(registry, templateId, content);
      expect(generator.validate(spec, ctx), `${templateId} validate`).toEqual([]);
      const first = generator.compose(spec, ctx);
      const second = generator.compose(spec, ctx);
      expect(first.scene.ops.length, `${templateId} ops`).toBeGreaterThan(0);
      expect(first.scene.background, `${templateId} background`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(
        first.scene.ops.some((op) => op.op === "text"),
        `${templateId} text op`,
      ).toBe(true);
      expect(second.scene, `${templateId} deterministic`).toEqual(first.scene);
      const rendered = await renderWithFixtures(first.scene);
      expect(rendered.bytes.length, `${templateId} bytes`).toBeGreaterThan(100);
      expect(Array.from(rendered.bytes.slice(0, 8)), `${templateId} png`).toEqual(PNG_MAGIC);
    }
  });

  it("injects the photo-caption photo full-bleed with a bottom scrim before the text", () => {
    const generator = generatorFor("composite");
    const spec = normalizedSpecFor(registry, "photo-caption", {
      caption: "Tormenta sobre la bahía",
      author: "Ana",
      locationLabel: "Valparaíso",
    });
    const { scene } = generator.compose(spec, ctx);
    const size = registry.size(spec.sizeId);

    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image).toMatchObject({
      ref: "photo",
      fit: "cover",
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
    });

    const scrim = scene.ops.find(
      (op): op is RectOp =>
        op.op === "rect" && op.alpha !== undefined && op.alpha >= 0.45 && op.alpha <= 0.6,
    );
    const palette = registry.palette(spec.paletteId);
    expect(scrim).toBeDefined();
    expect(scrim?.fill).toBe(paletteToken(palette.tokens, "background"));

    const imageIndex = scene.ops.findIndex((op) => op.op === "image");
    const scrimIndex = scrim === undefined ? -1 : scene.ops.indexOf(scrim);
    const textIndex = firstTextIndex(scene);
    expect(imageIndex).toBeLessThan(scrimIndex);
    expect(scrimIndex).toBeLessThan(textIndex);
    // The band reaches the canvas edge and starts above the caption slot.
    expect((scrim?.y ?? 0) + (scrim?.h ?? 0)).toBeCloseTo(size.height, 6);
    expect(scrim?.y ?? 0).toBeLessThan(size.height * 0.72);
  });

  it("tiles the watermark text in rotated groups at low alpha over the whole photo", () => {
    const generator = generatorFor("composite");
    const spec = normalizedSpecFor(registry, "watermark", { watermarkText: "CONFIDENCIAL" });
    const { scene } = generator.compose(spec, ctx);
    const size = registry.size(spec.sizeId);

    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image).toMatchObject({ ref: "photo", x: 0, y: 0, w: size.width, h: size.height });

    const textOps = collectTextOps(scene.ops);
    expect(textOps.length).toBeGreaterThanOrEqual(3);

    const rotated = scene.ops.filter(
      (op): op is GroupOp => op.op === "group" && op.rotateDeg !== undefined,
    );
    expect(rotated.length).toBeGreaterThanOrEqual(3);
    expect(rotated.length).toBeLessThanOrEqual(6);
    for (const group of rotated) {
      expect(group.rotateDeg).toBe(-30);
      const children = group.children.filter((op): op is TextOp => op.op === "text");
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child.text).toBe("CONFIDENCIAL");
        expect(child.alpha).toBeDefined();
        expect(child.alpha ?? 1).toBeLessThanOrEqual(0.35);
      }
    }

    const tiled = textOps.filter((op) => op.alpha !== undefined);
    expect(tiled).toHaveLength(rotated.length * 2);
    expect(tiled.every((op) => (op.alpha ?? 1) <= 0.35)).toBe(true);
    const expectedSize = Math.round(0.07 * Math.min(size.width, size.height));
    expect(tiled.every((op) => op.sizePx === expectedSize)).toBe(true);

    const imageIndex = scene.ops.findIndex((op) => op.op === "image");
    const firstGroupIndex = scene.ops.findIndex((op) => op.op === "group");
    expect(imageIndex).toBeLessThan(firstGroupIndex);
    expect(firstGroupIndex).toBeLessThan(firstTextIndex(scene));
  });

  it("draws 2, 3 or 4 collage images in slot order and rejects a single one", () => {
    const generator = generatorFor("composite");
    const content = { title: "Nuestro viaje", caption: "Un fin de semana junto al mar" };

    const refsFor = (ids: string[]): string[] => {
      const spec = rawSpec(registry, "image-collage", content, { images: imageFixtures(ids) });
      expect(generator.validate(spec, ctx), ids.join(",")).toEqual([]);
      return generator
        .compose(spec, ctx)
        .scene.ops.filter((op): op is ImageOp => op.op === "image")
        .map((op) => op.ref);
    };

    expect(refsFor(["photoA", "photoB"])).toEqual(["photoA", "photoB"]);
    expect(refsFor(["photoA", "photoB", "photoC"])).toEqual(["photoA", "photoB", "photoC"]);
    expect(refsFor(["photoA", "photoB", "photoC", "photoD"])).toEqual([
      "photoA",
      "photoB",
      "photoC",
      "photoD",
    ]);

    // Extra images with unknown ids are ignored silently.
    const extra = rawSpec(registry, "image-collage", content, {
      images: imageFixtures(["photoA", "photoB", "logo"]),
    });
    expect(generator.validate(extra, ctx)).toEqual([]);
    expect(
      generator
        .compose(extra, ctx)
        .scene.ops.filter((op) => op.op === "image")
        .map((op) => (op.op === "image" ? op.ref : "")),
    ).toEqual(["photoA", "photoB"]);

    const missing = generator.validate(
      rawSpec(registry, "image-collage", content, { images: imageFixtures(["photoA"]) }),
      ctx,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ code: "INVALID_SPEC", field: "images" });
    expect(missing[0]?.message).toContain("photoB");
  });

  it("reports missing or duplicated single photos for photo-caption and watermark", () => {
    const generator = generatorFor("composite");
    for (const templateId of ["photo-caption", "watermark"] as const) {
      const missing = generator.validate(rawSpec(registry, templateId, {}, { images: [] }), ctx);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ code: "INVALID_SPEC", field: "images" });
      expect(missing[0]?.message).toContain("missing: photo");

      const duplicated = generator.validate(
        rawSpec(registry, templateId, {}, { images: imageFixtures(["photo", "photo"]) }),
        ctx,
      );
      expect(duplicated).toHaveLength(1);
      expect(duplicated[0]?.message).toContain('found 2 entries with the id "photo"');
    }
  });

  it("keeps every injected graphic before the first text op", () => {
    const generator = generatorFor("composite");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["photo-caption", { caption: "Foto" }],
      ["watermark", { watermarkText: "MARCA" }],
      ["image-collage", { title: "Título" }],
    ];
    for (const [templateId, content] of cases) {
      const spec = normalizedSpecFor(registry, templateId, content);
      const { scene } = generator.compose(spec, ctx);
      const textIndex = firstTextIndex(scene);
      expect(textIndex, `${templateId} text`).toBeGreaterThan(0);
      for (const [index, op] of scene.ops.entries()) {
        if (
          op.op === "image" ||
          op.op === "group" ||
          (op.op === "rect" && op.alpha !== undefined)
        ) {
          expect(index, `${templateId} op ${op.op} at ${index}`).toBeLessThan(textIndex);
        }
      }
    }
  });
});
