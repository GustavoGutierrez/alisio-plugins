import { describe, expect, it } from "vitest";
import { paletteToken } from "../src/core/palettes.js";
import type { PathOp, RectOp, Scene, TextOp } from "../src/core/scene.js";
import { niceDomain } from "../src/generators/chart-primitives.js";
import { generatorFor } from "../src/generators/index.js";
import { boxToPx, contentFrame } from "../src/generators/shared.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { normalizedSpecFor, packagedRegistry, rawSpec } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHART_TEMPLATES = ["bar", "line", "scatter", "donut"] as const;

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

function chartContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Ingresos trimestrales",
    unit: "USD",
    categories: ["T1", "T2", "T3", "T4"],
    series: [
      { label: "2025", values: [12, 24, 18, 30] },
      { label: "2026", values: [15, null, 22, 35] },
    ],
    source: "Fuente: pruebas",
    ...overrides,
  };
}

function donutContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Reparto de sesiones",
    unit: "%",
    categories: ["Orgánico", "Directo", "Referidos"],
    series: [{ label: "Cuota", values: [40, 35, 25] }],
    source: "Fuente: pruebas",
    ...overrides,
  };
}

function chartPaths(scene: Scene): PathOp[] {
  return scene.ops.filter((op): op is PathOp => op.op === "path");
}

describe("chart generator", () => {
  it("composes and renders every chart template deterministically without warnings", async () => {
    const generator = generatorFor("chart");
    for (const templateId of CHART_TEMPLATES) {
      const content = templateId === "donut" ? donutContent() : chartContent();
      const spec = normalizedSpecFor(registry, templateId, content);
      expect(generator.validate(spec, ctx), `${templateId} validate`).toEqual([]);
      const first = generator.compose(spec, ctx);
      const second = generator.compose(spec, ctx);
      expect(first.warnings, `${templateId} warnings`).toEqual([]);
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

  it("starts the bar magnitude axis at zero and draws negative values below the baseline", () => {
    const generator = generatorFor("chart");
    const spec = normalizedSpecFor(
      registry,
      "bar",
      chartContent({
        unit: "",
        categories: ["A", "B", "C"],
        series: [{ values: [-5, 10, 0] }],
      }),
    );
    const { scene } = generator.compose(spec, ctx);
    const palette = registry.palette(spec.paletteId);
    const primary = paletteToken(palette.tokens, "primary");

    const baseline = scene.ops.find((op): op is RectOp => op.op === "rect" && op.alpha === 0.35);
    expect(baseline).toBeDefined();

    const bars = scene.ops.filter(
      (op): op is RectOp => op.op === "rect" && op.alpha === undefined && op.fill === primary,
    );
    expect(bars).toHaveLength(2);
    // Positive bars run up to the zero line; the negative one starts on it.
    expect(bars.some((bar) => Math.abs(bar.y + bar.h - (baseline?.y ?? -1)) < 0.001)).toBe(true);
    expect(bars.some((bar) => Math.abs(bar.y - (baseline?.y ?? -1)) < 0.001)).toBe(true);

    // All-zero values draw the baseline only.
    const zeroSpec = normalizedSpecFor(
      registry,
      "bar",
      chartContent({
        unit: "",
        categories: ["A", "B"],
        series: [{ values: [0, 0] }],
      }),
    );
    const zeroScene = generator.compose(zeroSpec, ctx).scene;
    const zeroBars = zeroScene.ops.filter(
      (op): op is RectOp => op.op === "rect" && op.alpha === undefined && op.fill === primary,
    );
    expect(zeroBars).toHaveLength(0);
    expect(zeroScene.ops.some((op) => op.op === "rect" && op.alpha === 0.35)).toBe(true);
  });

  it("breaks the line polyline at null values and skips bars for missing points", () => {
    const generator = generatorFor("chart");
    const lineSpec = normalizedSpecFor(
      registry,
      "line",
      chartContent({
        categories: ["T1", "T2", "T3", "T4", "T5"],
        series: [{ values: [1, 2, null, 4, 5] }],
      }),
    );
    const line = generator.compose(lineSpec, ctx).scene;
    const polylines = chartPaths(line).filter((op) => op.stroke !== undefined);
    expect(polylines).toHaveLength(2);
    expect(polylines.every((op) => op.d.startsWith("M "))).toBe(true);
    // Four non-null values keep four point dots (0.8u circles).
    const unit = Math.min(line.width, line.height) / 100;
    const dots = line.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        op.radius !== undefined &&
        op.fill !== undefined &&
        Math.abs(op.w - 1.6 * unit) < 0.001,
    );
    expect(dots).toHaveLength(4);

    const barSpec = normalizedSpecFor(
      registry,
      "bar",
      chartContent({ unit: "", categories: ["A", "B", "C"], series: [{ values: [1, null, 3] }] }),
    );
    const bar = generator.compose(barSpec, ctx).scene;
    const palette = registry.palette(barSpec.paletteId);
    const bars = bar.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        op.alpha === undefined &&
        op.fill === paletteToken(palette.tokens, "primary"),
    );
    expect(bars).toHaveLength(2);
  });

  it("rejects empty, all-null and malformed series and empty categories", () => {
    const generator = generatorFor("chart");
    const empty = generator.validate(
      rawSpec(registry, "bar", { categories: ["A"], series: [] }),
      ctx,
    );
    expect(empty.some((error) => error.field === "content.series")).toBe(true);

    const allNull = generator.validate(
      rawSpec(registry, "bar", { categories: ["A"], series: [{ values: [null] }] }),
      ctx,
    );
    expect(
      allNull.some((error) => error.field === "content.series" && /no values/.test(error.message)),
    ).toBe(true);

    const noCategories = generator.validate(
      rawSpec(registry, "bar", { categories: [], series: [1] }),
      ctx,
    );
    expect(noCategories.some((error) => error.field === "content.categories")).toBe(true);

    const tooManyValues = generator.validate(
      rawSpec(registry, "bar", { categories: ["A"], series: [{ values: [1, 2] }] }),
      ctx,
    );
    expect(tooManyValues.some((error) => /categories/.test(error.message))).toBe(true);

    const malformed = generator.validate(
      rawSpec(registry, "bar", { categories: ["A"], series: [{ values: ["x"] }] }),
      ctx,
    );
    expect(malformed.some((error) => /finite number or null/.test(error.message))).toBe(true);

    const nan = generator.validate(
      rawSpec(registry, "line", { categories: ["A"], series: [{ values: [Number.NaN] }] }),
      ctx,
    );
    expect(nan.some((error) => /finite number or null/.test(error.message))).toBe(true);
  });

  it("validates donut values: negative and zero-sum fail, positive sum renders the ring", () => {
    const generator = generatorFor("chart");
    const negative = generator.validate(
      normalizedSpecFor(registry, "donut", donutContent({ series: [{ values: [30, -5, 75] }] })),
      ctx,
    );
    expect(negative.some((error) => /non-negative/.test(error.message))).toBe(true);

    const zeroSum = generator.validate(
      normalizedSpecFor(registry, "donut", donutContent({ series: [{ values: [0, 0, 0] }] })),
      ctx,
    );
    expect(zeroSum.some((error) => /positive total/.test(error.message))).toBe(true);

    const positive = normalizedSpecFor(
      registry,
      "donut",
      donutContent({
        unit: "",
        categories: ["A", "B"],
        series: [{ values: [30, 70] }],
      }),
    );
    expect(generator.validate(positive, ctx)).toEqual([]);
    const { scene } = generator.compose(positive, ctx);
    const arcs = chartPaths(scene).filter((op) => op.strokeWidth !== undefined);
    expect(arcs).toHaveLength(2);
    expect(arcs.every((op) => (op.strokeWidth ?? 0) > 0)).toBe(true);
    expect(arcs.every((op) => op.d.includes(" A "))).toBe(true);
    const total = scene.ops.find((op): op is TextOp => op.op === "text" && op.text === "100");
    expect(total).toBeDefined();
    // The donut has no cartesian axes: no gridline rects.
    expect(scene.ops.filter((op) => op.op === "rect" && op.alpha === 0.12)).toHaveLength(0);
  });

  it("places the donut legend below in square layouts and right in landscape layouts", () => {
    const generator = generatorFor("chart");
    const squareSpec = normalizedSpecFor(registry, "donut", donutContent());
    const square = generator.compose(squareSpec, ctx).scene;
    const squareSize = registry.size(squareSpec.sizeId);
    const squarePlot = boxToPx(
      registry.template("donut").layouts.square?.plot ?? { x: 0, y: 0, w: 0, h: 0 },
      contentFrame(squareSize),
    );
    const squareUnit = Math.min(squareSize.width, squareSize.height) / 100;
    const squareSwatches = square.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        Math.abs(op.w - 1.5 * squareUnit) < 0.001 &&
        Math.abs(op.h - 1.5 * squareUnit) < 0.001,
    );
    expect(squareSwatches.length).toBeGreaterThanOrEqual(2);
    expect(squareSwatches.every((op) => op.y > squarePlot.y + squarePlot.h / 2)).toBe(true);

    const landscapeSpec = normalizedSpecFor(registry, "donut", donutContent(), {
      sizeId: "social-landscape",
    });
    const landscape = generator.compose(landscapeSpec, ctx).scene;
    const landscapeSize = registry.size(landscapeSpec.sizeId);
    const landscapePlot = boxToPx(
      registry.template("donut").layouts.landscape?.plot ?? { x: 0, y: 0, w: 0, h: 0 },
      contentFrame(landscapeSize),
    );
    const landscapeUnit = Math.min(landscapeSize.width, landscapeSize.height) / 100;
    const legendColumn = landscapePlot.w * 0.38;
    const diameter = Math.min(landscapePlot.h, landscapePlot.w - legendColumn - 2 * landscapeUnit);
    const ringCenterX = landscapePlot.x + diameter / 2;
    const landscapeSwatches = landscape.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        Math.abs(op.w - 1.5 * landscapeUnit) < 0.001 &&
        Math.abs(op.h - 1.5 * landscapeUnit) < 0.001,
    );
    expect(landscapeSwatches.length).toBeGreaterThanOrEqual(2);
    expect(landscapeSwatches.every((op) => op.x > ringCenterX)).toBe(true);
  });

  it("shows a legend for labeled multi-series and none for a single unlabeled series", () => {
    const generator = generatorFor("chart");
    const spec = normalizedSpecFor(registry, "bar", chartContent());
    const { scene } = generator.compose(spec, ctx);
    const size = registry.size(spec.sizeId);
    const unit = Math.min(size.width, size.height) / 100;
    const palette = registry.palette(spec.paletteId);

    const swatches = scene.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        Math.abs(op.w - 1.5 * unit) < 0.001 &&
        Math.abs(op.h - 1.5 * unit) < 0.001,
    );
    expect(swatches).toHaveLength(2);
    expect(swatches.map((op) => op.fill)).toEqual([
      paletteToken(palette.tokens, "primary"),
      paletteToken(palette.tokens, "secondary"),
    ]);
    const labels = scene.ops.filter(
      (op) => op.op === "text" && (op.text === "2025" || op.text === "2026"),
    );
    expect(labels).toHaveLength(2);

    const single = normalizedSpecFor(registry, "line", chartContent({ series: [1, 2, 3, 4] }));
    const singleScene = generator.compose(single, ctx).scene;
    const singleSwatches = singleScene.ops.filter(
      (op): op is RectOp =>
        op.op === "rect" &&
        Math.abs(op.w - 1.5 * unit) < 0.001 &&
        Math.abs(op.h - 1.5 * unit) < 0.001,
    );
    expect(singleSwatches).toHaveLength(0);
  });

  it("keeps chart geometry inside the layout plot box", () => {
    const generator = generatorFor("chart");
    for (const templateId of ["bar", "line", "scatter"] as const) {
      const spec = normalizedSpecFor(registry, templateId, chartContent());
      const { scene } = generator.compose(spec, ctx);
      const size = registry.size(spec.sizeId);
      const layout = registry.template(templateId).layouts[size.orientation];
      const plot = boxToPx(layout?.plot ?? { x: 0, y: 0, w: 0, h: 0 }, contentFrame(size));
      const unit = Math.min(size.width, size.height) / 100;
      // Bars, lines and dots (no alpha, palette fills/strokes) stay inside the plot.
      for (const op of scene.ops) {
        if (op.op === "rect" && op.alpha === undefined && op.fill !== scene.background) {
          expect(op.x, `${templateId} rect x`).toBeGreaterThanOrEqual(plot.x - 0.001);
          expect(op.x + op.w, `${templateId} rect right`).toBeLessThanOrEqual(
            plot.x + plot.w + 0.001,
          );
          expect(op.y, `${templateId} rect y`).toBeGreaterThanOrEqual(plot.y - 0.001);
          expect(op.y + op.h, `${templateId} rect bottom`).toBeLessThanOrEqual(
            plot.y + plot.h + 0.001,
          );
        }
      }
      expect(unit).toBeGreaterThan(0);
    }
  });
});

describe("chart primitives", () => {
  it("computes nice domains that include zero for bars and pad equal values", () => {
    const bars = niceDomain(10, 20, { includeZero: true });
    expect(bars.min).toBe(0);
    expect(bars.ticks).toContain(0);
    expect(bars.ticks.length).toBeGreaterThanOrEqual(4);
    expect(bars.ticks.length).toBeLessThanOrEqual(6);

    const negatives = niceDomain(-5, 10, { includeZero: true });
    expect(negatives.min).toBeLessThanOrEqual(-5);
    expect(negatives.ticks).toContain(0);

    const equal = niceDomain(5, 5, { includeZero: false });
    expect(equal.min).toBeCloseTo(4.5, 6);
    expect(equal.max).toBeCloseTo(5.5, 6);

    expect(niceDomain(0, 0, { includeZero: true })).toEqual({ min: 0, max: 0, ticks: [0] });

    const zeroLine = niceDomain(0, 0, { includeZero: false });
    expect(zeroLine.min).toBeLessThan(0);
    expect(zeroLine.max).toBeGreaterThan(0);
  });
});
