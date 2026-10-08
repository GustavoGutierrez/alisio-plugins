import { describe, expect, it } from "vitest";
import type { ImageOp, TextOp } from "../src/core/scene.js";
import { generatorFor } from "../src/generators/index.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { normalizedSpecFor, packagedRegistry, rawSpec } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DYNAMIC_TEMPLATES = ["inventory-product", "status-card"] as const;

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

describe("dynamic generator", () => {
  it("composes and renders every dynamic template deterministically", async () => {
    const generator = generatorFor("dynamic");
    for (const templateId of DYNAMIC_TEMPLATES) {
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
      expect(second.scene, `${templateId} deterministic snapshot`).toEqual(first.scene);
      const rendered = await renderWithFixtures(first.scene);
      expect(rendered.bytes.length, `${templateId} bytes`).toBeGreaterThan(100);
      expect(Array.from(rendered.bytes.slice(0, 8)), `${templateId} png`).toEqual(PNG_MAGIC);
    }
  });

  it("validates the required snapshot fields", () => {
    const generator = generatorFor("dynamic");
    expect(
      generator
        .validate(rawSpec(registry, "inventory-product", {}), ctx)
        .map((error) => error.field),
    ).toEqual(["content.productName", "content.price"]);
    expect(
      generator.validate(rawSpec(registry, "status-card", {}), ctx).map((error) => error.field),
    ).toEqual(["content.title", "content.status"]);
    expect(
      generator
        .validate(rawSpec(registry, "status-card", { title: "T" }), ctx)
        .map((error) => error.field),
    ).toEqual(["content.status"]);
  });

  it("places the inventory photo and skips absent optional content silently", () => {
    const generator = generatorFor("dynamic");
    const spec = normalizedSpecFor(registry, "inventory-product", {
      productName: "Café de origen",
      price: "12.50",
    });
    const { scene, warnings } = generator.compose(spec, ctx);
    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image?.ref).toBe("photo");
    expect(image?.fit).toBe("cover");
    expect(scene.ops.findIndex((op) => op.op === "image")).toBeLessThan(
      scene.ops.findIndex((op) => op.op === "text"),
    );
    // `updatedLabel` is optional: composeScene skips undefined content without a warning.
    expect(warnings).toEqual([]);
    expect(scene.ops.some((op) => op.op === "text" && op.text.includes("Actualizado"))).toBe(false);
  });

  it("renders updatedLabel only when explicit content carries it and never uses a clock", () => {
    const generator = generatorFor("dynamic");
    const spec = normalizedSpecFor(
      registry,
      "inventory-product",
      { productName: "Café", price: "12.50", updatedLabel: "Actualizado 2026-10-08" },
      { images: [] },
    );
    const { scene } = generator.compose(spec, ctx);
    const label = scene.ops.find(
      (op): op is TextOp => op.op === "text" && op.text === "Actualizado 2026-10-08",
    );
    expect(label).toBeDefined();
    expect(generator.compose(spec, ctx).scene).toEqual(scene);
  });

  it("adds a QR op when the snapshot carries one and renders it end to end", async () => {
    const generator = generatorFor("dynamic");
    const statusSpec = normalizedSpecFor(
      registry,
      "status-card",
      { title: "Pedido 4821", status: "En tránsito" },
      { qr: { payload: "https://example.com/track/4821" } },
    );
    const status = generator.compose(statusSpec, ctx);
    expect(status.scene.ops.some((op) => op.op === "qr")).toBe(true);

    const inventorySpec = normalizedSpecFor(
      registry,
      "inventory-product",
      { productName: "Café de origen", price: "12.50" },
      { qr: { payload: "https://example.com/p/12" } },
    );
    const inventory = generator.compose(inventorySpec, ctx);
    expect(inventory.scene.ops.some((op) => op.op === "qr")).toBe(true);

    const rendered = await renderWithFixtures(status.scene);
    expect(rendered.bytes.length).toBeGreaterThan(100);
    expect(Array.from(rendered.bytes.slice(0, 8))).toEqual(PNG_MAGIC);
  });
});
