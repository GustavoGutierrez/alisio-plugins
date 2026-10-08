import { describe, expect, it } from "vitest";
import { normalizeSpec } from "../src/core/design-spec.js";
import { paletteToken } from "../src/core/palettes.js";
import type { ImageOp, TextOp } from "../src/core/scene.js";
import { generatorFor } from "../src/generators/index.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { captureError, normalizedSpecFor, packagedRegistry, rawSpec } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PERSONALIZED_TEMPLATES = ["certificate-classic", "badge-clean", "banner-promo"] as const;

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

describe("personalized generator", () => {
  it("composes and renders every personalized template deterministically", async () => {
    const generator = generatorFor("personalized");
    for (const templateId of PERSONALIZED_TEMPLATES) {
      const spec = normalizedSpecFor(registry, templateId);
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

  it("requires a non-empty certificate recipient", () => {
    const generator = generatorFor("personalized");
    const missing = generator.validate(
      rawSpec(registry, "certificate-classic", { courseTitle: "Curso" }),
      ctx,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      code: "INVALID_SPEC",
      field: "content.recipientName",
    });

    const blank = generator.validate(
      rawSpec(registry, "certificate-classic", { recipientName: "   ", courseTitle: "Curso" }),
      ctx,
    );
    expect(blank).toHaveLength(1);

    // badge-clean tolerates a missing optional photo.
    const badge = normalizedSpecFor(registry, "badge-clean", { personName: "Ada" }, { images: [] });
    expect(generator.validate(badge, ctx)).toEqual([]);
  });

  it("fits a realistic long name and throws TEXT_OVERFLOW instead of truncating", () => {
    const generator = generatorFor("personalized");
    const longName = "María del Carmen Fernández de la Vega Gutiérrez y Mendoza de los Ríos";
    const spec = rawSpec(registry, "certificate-classic", {
      recipientName: longName,
      courseTitle: "Diplomado en Gestión de Proyectos",
    });
    expect(generator.validate(spec, ctx)).toEqual([]);

    const { scene } = generator.compose(spec, ctx);
    const nameOp = scene.ops.find((op): op is TextOp => op.op === "text" && op.text === longName);
    expect(nameOp).toBeDefined();
    expect(nameOp?.lines.join(" ")).toContain("Mendoza");

    const pathological = rawSpec(registry, "certificate-classic", {
      recipientName: "Nombre ".repeat(50).trim(),
      courseTitle: "Diplomado",
    });
    const error = captureError(() => generator.compose(pathological, ctx));
    expect(error.code).toBe("TEXT_OVERFLOW");
  });

  it("adds the double frame and the QR op to certificate-classic", () => {
    const spec = normalizedSpecFor(
      registry,
      "certificate-classic",
      { recipientName: "Ada Lovelace", courseTitle: "Análisis", entity: "Alisio" },
      { qr: { payload: "https://example.com/verify/ada" } },
    );
    const { scene } = generatorFor("personalized").compose(spec, ctx);
    expect(scene.ops.some((op) => op.op === "qr")).toBe(true);

    // The frame is injected immediately before the first text op: outer ring, then inner ring.
    const firstText = scene.ops.findIndex((op) => op.op === "text");
    expect(firstText).toBeGreaterThanOrEqual(2);
    const outer = scene.ops[firstText - 2];
    const inner = scene.ops[firstText - 1];
    expect(outer?.op).toBe("path");
    expect(inner?.op).toBe("path");
    if (outer?.op === "path" && inner?.op === "path") {
      const palette = registry.palette(spec.paletteId);
      expect(outer.stroke).toBe(paletteToken(palette.tokens, "primary"));
      expect(inner.stroke).toBe(paletteToken(palette.tokens, "accent"));
      expect(outer.strokeWidth).toBeGreaterThan(0);
      expect(outer.d).toContain("A ");
      expect(outer.fill).toBeUndefined();
    }
  });

  it("places the optional badge photo with the template fit and round", () => {
    const generator = generatorFor("personalized");
    const spec = normalizedSpecFor(registry, "badge-clean", {
      personName: "Ada Lovelace",
      role: "Pionera",
    });
    const { scene } = generator.compose(spec, ctx);
    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image?.ref).toBe("photo");
    expect(image?.fit).toBe("cover");
    expect(image?.round).toBe("circle");
    expect(scene.ops.findIndex((op) => op.op === "image")).toBeLessThan(
      scene.ops.findIndex((op) => op.op === "text"),
    );

    const withoutPhoto = generator.compose(
      normalizedSpecFor(registry, "badge-clean", { personName: "Ada Lovelace" }, { images: [] }),
      ctx,
    );
    expect(withoutPhoto.scene.ops.some((op) => op.op === "image")).toBe(false);
  });

  it("injects the banner product image only when the spec provides one", () => {
    const generator = generatorFor("personalized");
    const spec = normalizedSpecFor(registry, "banner-promo", {
      headline: "Oferta",
      cta: "Comprar",
    });
    const { scene } = generator.compose(spec, ctx);
    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image?.ref).toBe("product");
    expect(image?.fit).toBe("cover");
    expect(image?.round).toBeUndefined();
    expect(scene.ops.findIndex((op) => op.op === "image")).toBeLessThan(
      scene.ops.findIndex((op) => op.op === "text"),
    );

    const withoutProduct = generator.compose(
      normalizedSpecFor(registry, "banner-promo", { headline: "Oferta" }, { images: [] }),
      ctx,
    );
    expect(withoutProduct.scene.ops.some((op) => op.op === "image")).toBe(false);
  });

  it("adapts badge-clean to a landscape size and reports wrong orientations with alternatives", () => {
    const badge = normalizeSpec(
      {
        family: "personalized",
        templateId: "badge-clean",
        content: { personName: "Ada Lovelace" },
      },
      registry,
    );
    expect(badge.ok).toBe(true);
    if (!badge.ok) return;
    expect(registry.size(badge.spec.sizeId).orientation).toBe("landscape");

    // badge-clean only ships a landscape layout.
    const badgeWrong = normalizeSpec(
      {
        family: "personalized",
        templateId: "badge-clean",
        sizeId: "social-portrait",
        content: { personName: "Ada" },
      },
      registry,
    );
    expect(badgeWrong.ok).toBe(false);
    if (!badgeWrong.ok) {
      const error = badgeWrong.errors.find((entry) => entry.code === "INCOMPATIBLE_SIZE");
      expect(error).toBeDefined();
      expect((error?.details?.alternatives as string[] | undefined)?.length).toBeGreaterThan(0);
    }

    // certificate-classic ships portrait and landscape layouts, so square is the incompatible one.
    const certificateWrong = normalizeSpec(
      {
        family: "personalized",
        templateId: "certificate-classic",
        sizeId: "social-square",
        content: { recipientName: "Ada", courseTitle: "Curso" },
      },
      registry,
    );
    expect(certificateWrong.ok).toBe(false);
    if (!certificateWrong.ok) {
      const error = certificateWrong.errors.find((entry) => entry.code === "INCOMPATIBLE_SIZE");
      expect(error).toBeDefined();
      const alternatives = error?.details?.alternatives as string[] | undefined;
      expect(alternatives?.length).toBeGreaterThan(0);
      expect(alternatives).toContain("certificate-a4-landscape");
    }
  });
});
