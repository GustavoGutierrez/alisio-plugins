import { describe, expect, it } from "vitest";
import { cardCatalog, RENDERER_VERSION, renderCard } from "../src/renderer.js";
import { captureAsyncError, captureError } from "./helpers.js";
import {
  decodeRendered,
  isNear,
  type PixelBuffer,
  pixelAt,
  solidPngBytes,
} from "./render-helpers.js";

const MINIMAL_SOCIAL = {
  family: "social" as const,
  templateId: "illustrated-greeting",
  content: { title: "Que tengas un gran día" },
};

function containsColor(pixels: PixelBuffer, target: readonly [number, number, number]): boolean {
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (isNear(pixelAt(pixels, x, y), target)) return true;
    }
  }
  return false;
}

describe("renderer entry", () => {
  it("renders a minimal social spec to PNG bytes, dimensions and warnings", async () => {
    const card = await renderCard(MINIMAL_SOCIAL, { scale: 0.25 });
    expect(card.mimeType).toBe("image/png");
    expect(card.scale).toBe(0.25);
    // Default social size is social-portrait (1080x1350), scaled and rounded like renderScene.
    expect(card.width).toBe(Math.round(1080 * 0.25));
    expect(card.height).toBe(Math.round(1350 * 0.25));
    expect(card.bytes.byteLength).toBeGreaterThan(1_000);
    expect([...card.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(card.warnings.length).toBeGreaterThan(0);
    expect(card.warnings.every((warning) => typeof warning === "string")).toBe(true);
  });

  it("renders JPEG when requested", async () => {
    const card = await renderCard(MINIMAL_SOCIAL, {
      format: "jpeg",
      jpegQuality: 80,
      scale: 0.08,
    });
    expect(card.mimeType).toBe("image/jpeg");
    expect(card.bytes[0]).toBe(0xff);
    expect(card.bytes[1]).toBe(0xd8);
    expect(card.width).toBe(Math.round(1080 * 0.08));
    expect(card.height).toBe(Math.round(1350 * 0.08));
  });

  it("rejects an invalid spec with INVALID_SPEC and structured errors", async () => {
    const error = await captureAsyncError(() =>
      renderCard({ family: "social", templateId: "illustrated-greeting", content: {} }),
    );
    expect(error.code).toBe("INVALID_SPEC");
    const errors = (error.details as { errors?: unknown[] } | undefined)?.errors;
    expect(Array.isArray(errors)).toBe(true);
    expect((errors ?? []).length).toBeGreaterThan(0);
  });

  it("reports an unknown template inside INVALID_SPEC errors", async () => {
    const error = await captureAsyncError(() =>
      renderCard({ family: "social", templateId: "does-not-exist", content: { title: "x" } }),
    );
    expect(error.code).toBe("INVALID_SPEC");
    const errors =
      (error.details as { errors?: Array<{ code: string }> } | undefined)?.errors ?? [];
    expect(errors.some((entry) => entry.code === "UNKNOWN_TEMPLATE")).toBe(true);
  });

  it("renders a collage from in-memory imageData and keeps both images", async () => {
    const card = await renderCard(
      {
        family: "composite",
        templateId: "image-collage",
        content: { title: "Dos fotos", caption: "Datos en memoria" },
        images: [
          { id: "photoA", path: "a.png" },
          { id: "photoB", path: "b.png" },
        ],
      },
      {
        imageData: [
          { id: "photoA", data: solidPngBytes(64, 64, "#3366cc") },
          { id: "photoB", data: solidPngBytes(64, 64, "#cc3366") },
        ],
        scale: 0.1,
      },
    );
    expect(card.width).toBe(108);
    expect(card.height).toBe(108);
    const pixels = await decodeRendered(card);
    expect(containsColor(pixels, [0x33, 0x66, 0xcc])).toBe(true);
    expect(containsColor(pixels, [0xcc, 0x33, 0x66])).toBe(true);
  });

  it("lists the 16 packaged templates and resource ids via cardCatalog()", () => {
    const catalog = cardCatalog();
    expect(catalog.templates).toHaveLength(16);
    expect(catalog.templates.map((entry) => entry.id)).toContain("illustrated-greeting");
    expect(catalog.palettes).toHaveLength(6);
    expect(catalog.fontPairs).toHaveLength(6);
    expect(catalog.illustrations).toHaveLength(39);
    expect(catalog.illustrations.map((entry) => entry.id)).toContain("star-burst");
    expect(catalog.illustrations.find((entry) => entry.id === "cat-face")?.tags).toEqual([
      "kawaii",
    ]);
    expect(
      catalog.templates.find((entry) => entry.id === "certificate-classic")?.defaultIllustration,
    ).toBe("seal-ring");
    expect(catalog.formats).toEqual(["png", "jpeg"]);
  });

  it("filters the catalog and rejects unknown ids", () => {
    const charts = cardCatalog({ family: "chart" });
    expect(charts.templates).toHaveLength(4);
    expect(charts.templates.every((entry) => entry.family === "chart")).toBe(true);

    const single = cardCatalog({ templateId: "bar" });
    expect(single.templates.map((entry) => entry.id)).toEqual(["bar"]);

    expect(captureError(() => cardCatalog({ templateId: "nope" })).code).toBe("UNKNOWN_TEMPLATE");
    expect(captureError(() => cardCatalog({ family: "nope" as never })).code).toBe("INVALID_SPEC");
  });

  it("exports a semantic RENDERER_VERSION", () => {
    expect(RENDERER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
