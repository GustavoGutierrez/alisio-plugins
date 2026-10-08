import { describe, expect, it } from "vitest";
import { normalizeSpec } from "../src/core/design-spec.js";
import { paletteToken } from "../src/core/palettes.js";
import type { ImageOp, RectOp, Scene, SceneOp, TextOp } from "../src/core/scene.js";
import { GENERATOR_FAMILIES, generatorFor } from "../src/generators/index.js";
import {
  imageSlotBox,
  missingImages,
  mulberry32,
  parseMetricRows,
  requiredImageIds,
  withInjectedOps,
} from "../src/generators/shared.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { normalizedSpecFor, packagedRegistry, rawSpec } from "./helpers.js";
import { renderWithFixtures } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SOCIAL_TEMPLATES = [
  "editorial-photo",
  "illustrated-greeting",
  "retro-message",
  "metric-summary",
] as const;

const registry = packagedRegistry();
const measurer = createTextMeasurer();
const ctx = { registry, measurer };

/** Seeded confetti dots: small square rects rounded into circles, at most 2u wide. */
function jitterDots(scene: Scene): RectOp[] {
  const limit = 0.02 * Math.min(scene.width, scene.height);
  return scene.ops.filter(
    (op): op is RectOp =>
      op.op === "rect" &&
      op.radius !== undefined &&
      op.radius === op.w / 2 &&
      op.w === op.h &&
      op.w <= limit + 1e-9,
  );
}

function rectOp(x: number): SceneOp {
  return { op: "rect", x, y: 0, w: 1, h: 1, fill: "#000000" };
}

describe("social generator", () => {
  it("composes and renders every social template deterministically", async () => {
    const generator = generatorFor("social");
    for (const templateId of SOCIAL_TEMPLATES) {
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

  it("injects the editorial photo and a legibility scrim before the text", () => {
    const spec = normalizedSpecFor(registry, "editorial-photo", {
      title: "Titular de prueba",
      kicker: "Noticias",
      author: "Redacción",
    });
    const { scene } = generatorFor("social").compose(spec, ctx);
    const size = registry.size(spec.sizeId);
    expect(size.id).toBe("social-portrait");

    const image = scene.ops.find((op): op is ImageOp => op.op === "image");
    expect(image).toBeDefined();
    expect(image?.ref).toBe("photo");
    expect(image?.fit).toBe("cover");
    expect(image?.w).toBeCloseTo(size.width, 6);
    expect(image?.h).toBeCloseTo(size.height * 0.54, 6);

    const firstText = scene.ops.findIndex((op) => op.op === "text");
    expect(scene.ops.findIndex((op) => op.op === "image")).toBeLessThan(firstText);

    const palette = registry.palette(spec.paletteId);
    const scrim = scene.ops.find(
      (op): op is RectOp =>
        op.op === "rect" && op.alpha !== undefined && op.alpha >= 0.25 && op.alpha <= 0.35,
    );
    expect(scrim?.fill).toBe(paletteToken(palette.tokens, "background"));
  });

  it("adds deterministic seeded confetti to retro-message and none without a seed", () => {
    const generator = generatorFor("social");
    const content = { title: "Buenas vibras", message: "Hoy es un gran día" };
    const base = generator.compose(
      normalizedSpecFor(registry, "retro-message", content),
      ctx,
    ).scene;
    const seeded42 = generator.compose(
      normalizedSpecFor(registry, "retro-message", content, { seed: 42 }),
      ctx,
    ).scene;
    const seeded42Again = generator.compose(
      normalizedSpecFor(registry, "retro-message", content, { seed: 42 }),
      ctx,
    ).scene;
    const seeded43 = generator.compose(
      normalizedSpecFor(registry, "retro-message", content, { seed: 43 }),
      ctx,
    ).scene;

    expect(jitterDots(base)).toHaveLength(0);
    expect(seeded42).toEqual(seeded42Again);
    expect(seeded42).not.toEqual(seeded43);

    const dots = jitterDots(seeded42);
    expect(dots.length).toBeGreaterThanOrEqual(6);
    expect(dots.length).toBeLessThanOrEqual(10);
    const size = registry.size("social-portrait");
    const palette = registry.palette("retro-calido");
    const allowed = new Set([
      paletteToken(palette.tokens, "accent"),
      paletteToken(palette.tokens, "primary"),
      paletteToken(palette.tokens, "secondary"),
    ]);
    for (const dot of dots) {
      expect(dot.y + dot.h).toBeLessThanOrEqual(size.height * 0.4);
      expect(dot.fill).toBeDefined();
      if (dot.fill !== undefined) expect(allowed.has(dot.fill)).toBe(true);
    }
  });

  it("renders parsed metric rows with left labels, right values and dividers", () => {
    const spec = normalizedSpecFor(registry, "metric-summary", {
      metrics: ["Users | 1,200", "Revenue | $4,500", "Uptime | 99.9%"],
    });
    const { scene } = generatorFor("social").compose(spec, ctx);
    const palette = registry.palette(spec.paletteId);

    // The raw joined block never reaches the scene: rows render once through the plot.
    expect(scene.ops.some((op) => op.op === "text" && op.text.includes("\n"))).toBe(false);

    const texts = scene.ops.filter((op): op is TextOp => op.op === "text");
    const label = texts.find((op) => op.text === "Users");
    expect(label).toMatchObject({
      align: "left",
      color: paletteToken(palette.tokens, "text"),
      valign: "middle",
    });
    const value = texts.find((op) => op.text === "1,200");
    expect(value).toMatchObject({
      align: "right",
      color: paletteToken(palette.tokens, "primary"),
    });

    const dividers = scene.ops.filter((op): op is RectOp => op.op === "rect" && op.alpha === 0.35);
    expect(dividers).toHaveLength(2);
    expect(dividers.every((op) => op.fill === paletteToken(palette.tokens, "secondary"))).toBe(
      true,
    );
  });

  it("reports family-specific validation errors", () => {
    const generator = generatorFor("social");
    const missingPhoto = generator.validate(
      normalizedSpecFor(registry, "editorial-photo", { title: "Hola" }, { images: [] }),
      ctx,
    );
    expect(
      missingPhoto.some((error) => error.code === "INVALID_SPEC" && error.field === "images"),
    ).toBe(true);

    const blankMetrics = generator.validate(
      normalizedSpecFor(registry, "metric-summary", { metrics: ["", "   ", "  |  "] }),
      ctx,
    );
    expect(blankMetrics.some((error) => error.field === "content.metrics")).toBe(true);

    const qrDefensive = generator.validate(
      rawSpec(
        registry,
        "illustrated-greeting",
        { title: "Hola" },
        {
          qr: { payload: "https://example.com" },
        },
      ),
      ctx,
    );
    expect(qrDefensive.some((error) => error.field === "qr")).toBe(true);
  });

  it("rejects unknown templates and mismatched families through normalizeSpec", () => {
    const unknown = normalizeSpec(
      { family: "social", templateId: "no-such-template", content: {} },
      registry,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]?.code).toBe("UNKNOWN_TEMPLATE");

    const wrongFamily = normalizeSpec(
      {
        family: "social",
        templateId: "certificate-classic",
        content: { recipientName: "Ada", courseTitle: "Curso" },
      },
      registry,
    );
    expect(wrongFamily.ok).toBe(false);
    if (!wrongFamily.ok) {
      expect(
        wrongFamily.errors.some(
          (error) => error.code === "INVALID_SPEC" && error.field === "family",
        ),
      ).toBe(true);
    }
  });
});

describe("generator shared helpers", () => {
  it("inserts injected ops immediately before the first text op and copies the scene", () => {
    const text: SceneOp = {
      op: "text",
      text: "hola",
      x: 0,
      y: 0,
      font: { alias: "CardsmithInter400", family: "Inter", weight: 400 },
      sizePx: 10,
      color: "#111111",
      lineHeight: 12,
      lines: ["hola"],
      maxWidth: 10,
    };
    const scene: Scene = {
      width: 100,
      height: 100,
      background: "#ffffff",
      ops: [rectOp(0), text, rectOp(20)],
    };
    const next = withInjectedOps(scene, [rectOp(5), rectOp(10)]);
    expect(next.ops.map((op) => (op.op === "rect" ? op.x : -1))).toEqual([0, 5, 10, -1, 20]);
    expect(next.ops[0]).toBe(scene.ops[0]);
    expect(scene.ops).toHaveLength(3);

    const appended = withInjectedOps({ ...scene, ops: [rectOp(0)] }, [rectOp(5)]);
    expect(appended.ops.map((op) => (op.op === "rect" ? op.x : -1))).toEqual([0, 5]);
  });

  it("mulberry32 is deterministic and seed-dependent", () => {
    const sequence = (seed: number): number[] => {
      const random = mulberry32(seed);
      return [random(), random(), random(), random(), random()];
    };
    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
    for (const value of sequence(42)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("parses metric rows on the first pipe and skips empty lines", () => {
    expect(
      parseMetricRows(["Users | 1200", "Revenue|$4,500", "No pipe", "  ", "A | B | C"]),
    ).toEqual([
      { label: "Users", value: "1200" },
      { label: "Revenue", value: "$4,500" },
      { label: "No pipe", value: "" },
      { label: "A", value: "B | C" },
    ]);
  });

  it("treats a {0,0,1,1} image box as full-bleed and the rest as safe-area content", () => {
    const story = registry.size("story-vertical");
    expect(imageSlotBox({ key: "photo", box: { x: 0, y: 0, w: 1, h: 1 } }, story)).toEqual({
      x: 0,
      y: 0,
      w: 1080,
      h: 1920,
    });
    expect(imageSlotBox({ key: "photo", box: { x: 0, y: 0, w: 1, h: 0.5 } }, story)).toEqual({
      x: 80,
      y: 250,
      w: 920,
      h: 710,
    });
  });

  it("maps provided image ids and reports missing ones", () => {
    const spec = rawSpec(
      registry,
      "editorial-photo",
      { title: "X" },
      {
        images: [{ id: "photo", path: "test://photo.png" }],
      },
    );
    expect(requiredImageIds(spec)).toEqual(["photo"]);
    expect(missingImages(spec, ["photo", "logo"])).toEqual(["logo"]);
  });
});

describe("generator registry", () => {
  it("exposes all five families with matching generators", () => {
    expect(GENERATOR_FAMILIES).toEqual(["social", "personalized", "composite", "chart", "dynamic"]);
    for (const family of GENERATOR_FAMILIES) {
      expect(generatorFor(family).family).toBe(family);
    }
  });
});
