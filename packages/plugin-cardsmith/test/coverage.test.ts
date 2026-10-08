import { describe, expect, it } from "vitest";
import type { NormalizedSpec } from "../src/core/design-spec.js";
import { type DesignSpecInput, normalizeSpec } from "../src/core/design-spec.js";
import type { Template } from "../src/core/registry.js";
import { SIZE_PRESETS, type SizePreset } from "../src/core/sizes.js";
import { generatorFor } from "../src/generators/index.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { minimalContent, packagedRegistry, templateImageIds } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

/** Plausible fixture content per template: required fields plus family-specific data. */
function fixtureContent(template: Template): Record<string, unknown> {
  const content = minimalContent(template);
  switch (template.id) {
    case "photo-caption":
      content.caption = "Atardecer en el puerto";
      content.author = "Equipo Cardsmith";
      content.locationLabel = "Puerto";
      break;
    case "watermark":
      content.watermarkText = "CONFIDENCIAL";
      break;
    case "image-collage":
      content.title = "Nuestro viaje";
      content.caption = "Un fin de semana junto al mar";
      break;
    case "bar":
    case "line":
    case "scatter":
      content.title = "Ingresos trimestrales";
      content.unit = "USD";
      content.categories = ["T1", "T2", "T3", "T4"];
      content.series = [{ label: "2025", values: [12, 24, null, 30] }];
      content.source = "Fuente: fixtures";
      break;
    case "donut":
      content.title = "Reparto de sesiones";
      content.unit = "%";
      content.categories = ["Orgánico", "Directo", "Referidos"];
      content.series = [{ label: "Cuota", values: [40, 35, 25] }];
      content.source = "Fuente: fixtures";
      break;
    case "metric-summary":
      content.metrics = ["Usuarios | 1.200", "Ingresos | $4.500"];
      break;
  }
  return content;
}

function specFor(template: Template, preset: SizePreset): NormalizedSpec {
  const input: DesignSpecInput = {
    family: template.family,
    templateId: template.id,
    sizeId: preset.id,
    content: fixtureContent(template),
  };
  if (template.supports.images) {
    input.images = templateImageIds(template).map((id) => ({ id, path: `test://${id}.png` }));
  }
  const result = normalizeSpec(input, registry);
  if (!result.ok) {
    throw new Error(`${template.id}/${preset.id}: ${JSON.stringify(result.errors)}`);
  }
  return result.spec;
}

interface MatrixEntry {
  template: Template;
  preset: SizePreset;
}

/** Every template id × every compatible size preset (spec §16.1 release-gate matrix). */
const matrix: MatrixEntry[] = [];
for (const entry of registry.catalog().templates) {
  const template = registry.template(entry.id);
  for (const preset of SIZE_PRESETS) {
    if (template.layouts[preset.orientation] !== undefined) matrix.push({ template, preset });
  }
}

describe("release-gate coverage matrix", () => {
  it("composes every template and every compatible size preset", () => {
    // 16 templates × their compatible orientations: 1 square, 4 portrait and 4 landscape presets.
    expect(matrix.length).toBe(94);
    for (const { template, preset } of matrix) {
      const label = `${template.id}/${preset.id}`;
      const spec = specFor(template, preset);
      const generator = generatorFor(template.family);
      expect(generator.validate(spec, ctx), `${label} validate`).toEqual([]);
      const { scene, warnings } = generator.compose(spec, ctx);
      expect(scene.background, `${label} background`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(scene.ops.length, `${label} ops`).toBeGreaterThan(0);
      expect(warnings, `${label} warnings`).toEqual([]);
    }
  });

  it("renders one representative size per template at preview scale", async () => {
    const representatives = new Map<string, MatrixEntry>();
    for (const entry of matrix) {
      if (!representatives.has(entry.template.id)) representatives.set(entry.template.id, entry);
    }
    expect(representatives.size).toBe(16);
    for (const { template, preset } of representatives.values()) {
      const label = `${template.id}/${preset.id}`;
      const spec = specFor(template, preset);
      const { scene } = generatorFor(template.family).compose(spec, ctx);
      const rendered = await renderWithFixtures(scene, 0.15);
      expect(rendered.bytes.length, `${label} bytes`).toBeGreaterThan(100);
      expect(Array.from(rendered.bytes.slice(0, 8)), `${label} png`).toEqual(PNG_MAGIC);
    }
  });
});
