import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { normalizeSpec } from "../src/core/design-spec.js";
import { composeScene } from "../src/core/layout.js";
import type { Registry } from "../src/core/registry.js";
import type { Scene, TextOp } from "../src/core/scene.js";
import { fitText } from "../src/core/typography.js";
import { createTextMeasurer } from "../src/renderers/measure.js";
import { renderScene } from "../src/renderers/skia.js";
import { makeFixtureRegistry } from "./helpers.js";
import { countInk, decodeRendered, pixelAt } from "./render-helpers.js";

const SIZE = 1080;
const TITLE = "Un día espectacular para celebrar juntos y recordar siempre";
const NAME = "María Fernanda Gutiérrez de los Ríos y del Valle";

const TEXT_TEMPLATE: Record<string, unknown> = {
  id: "fixture-text",
  version: 1,
  family: "personalized",
  label: { es: "Texto", en: "Text" },
  layouts: {
    square: {
      background: "$background",
      slots: [
        {
          key: "title",
          role: "display",
          box: { x: 0.08, y: 0.08, w: 0.84, h: 0.16 },
          size: 96,
          align: "center",
          valign: "middle",
          maxLines: 2,
        },
        {
          key: "name",
          role: "bodyStrong",
          box: { x: 0.1, y: 0.4, w: 0.8, h: 0.12 },
          size: 44,
          align: "center",
          valign: "middle",
          maxLines: 2,
        },
      ],
    },
  },
  fields: [
    { key: "title", type: "text", required: true, overflow: "error" },
    { key: "name", type: "text", required: true, overflow: "error" },
  ],
  defaultPalette: "certificado-marfil",
  defaultFontPair: "handwritten-elegant",
  supports: { qr: false, illustration: false, images: false },
};

let cachedRegistry: Promise<Registry> | undefined;

function registry(): Promise<Registry> {
  cachedRegistry ??= makeFixtureRegistry({ templates: [TEXT_TEMPLATE] });
  return cachedRegistry;
}

async function composeText(content: Record<string, unknown>): Promise<Scene> {
  const instance = await registry();
  const result = normalizeSpec(
    { family: "personalized", templateId: "fixture-text", sizeId: "social-square", content },
    instance,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const palette = instance.palette(result.spec.paletteId);
  return composeScene(
    instance.template(result.spec.templateId),
    "square",
    result.spec,
    palette,
    instance,
    { measurer: createTextMeasurer() },
  ).scene;
}

describe("text rendering", () => {
  it("fits long Spanish titles and names inside their slot boxes on a real canvas", async () => {
    const scene = await composeText({ title: TITLE, name: NAME });
    const textOps = scene.ops.filter((op): op is TextOp => op.op === "text");
    expect(textOps).toHaveLength(2);

    const boxes = new Map<string, { w: number; h: number }>([
      [TITLE, { w: 0.84 * SIZE, h: 0.16 * SIZE }],
      [NAME, { w: 0.8 * SIZE, h: 0.12 * SIZE }],
    ]);
    const canvas = createCanvas(16, 16);
    const ctx = canvas.getContext("2d");
    for (const op of textOps) {
      const box = boxes.get(op.text);
      expect(box, `unexpected text op "${op.text}"`).toBeDefined();
      ctx.font = `${op.font.weight} ${op.sizePx}px "${op.font.alias}"`;
      for (const line of op.lines) {
        expect(ctx.measureText(line).width).toBeLessThanOrEqual(op.maxWidth + 0.5);
        expect(ctx.measureText(line).width).toBeLessThanOrEqual((box?.w ?? 0) + 0.5);
      }
      expect(op.lines.length * op.lineHeight).toBeLessThanOrEqual((box?.h ?? 0) + 0.5);
    }

    const rendered = await renderScene(scene, { format: "png", scale: 0.5 });
    const pixels = await decodeRendered(rendered);
    expect(countInk(pixels, { x: 43, y: 43, w: 454, h: 87 })).toBeGreaterThan(0);
    expect(countInk(pixels, { x: 54, y: 216, w: 432, h: 65 })).toBeGreaterThan(0);
    // both boxes lie inside the safe frame: nothing was drawn silently outside them
    expect(countInk(pixels)).toBeLessThan(100_000);
  });

  it("does not overflow directly through fitText with the same measurer", () => {
    const measurer = createTextMeasurer();
    const display = { alias: "CardsmithCaveat700", family: "Caveat", weight: 700 };
    const bodyStrong = {
      alias: "CardsmithCormorantGaramond600",
      family: "Cormorant Garamond",
      weight: 600,
    };

    const titleFit = fitText(
      {
        text: TITLE,
        font: display,
        maxWidth: 0.84 * SIZE,
        maxHeight: 0.16 * SIZE,
        maxSize: 96,
        minSize: 24,
        maxLines: 2,
        breakPolicy: "word-then-char",
      },
      measurer,
    );
    expect(titleFit.overflow).toBe(false);
    expect(titleFit.lines.join(" ")).toBe(TITLE);
    expect(titleFit.width).toBeLessThanOrEqual(0.84 * SIZE + 0.5);
    expect(titleFit.height).toBeLessThanOrEqual(0.16 * SIZE + 0.5);

    const nameFit = fitText(
      {
        text: NAME,
        font: bodyStrong,
        maxWidth: 0.8 * SIZE,
        maxHeight: 0.12 * SIZE,
        maxSize: 44,
        minSize: 11,
        maxLines: 2,
        breakPolicy: "word-then-char",
      },
      measurer,
    );
    expect(nameFit.overflow).toBe(false);
    expect(nameFit.lines.join(" ")).toBe(NAME);
    expect(nameFit.width).toBeLessThanOrEqual(0.8 * SIZE + 0.5);
    expect(nameFit.height).toBeLessThanOrEqual(0.12 * SIZE + 0.5);
  });

  it("renders curved text inside the expected annulus", async () => {
    const sizePx = 24;
    const radius = 100;
    const cx = 150;
    const cy = 150;

    const renderCurve = async (
      curve: TextOp["curve"],
    ): Promise<{ ink: number; min: number; max: number }> => {
      const op: TextOp = {
        op: "text",
        text: "CURVED TEXT",
        x: cx,
        y: cy,
        font: { alias: "CardsmithInter600", family: "Inter", weight: 600 },
        sizePx,
        color: "#000000",
        lineHeight: 30,
        lines: ["CURVED TEXT"],
        maxWidth: 300,
      };
      if (curve !== undefined) op.curve = curve;
      const scene: Scene = { width: 300, height: 300, background: "#ffffff", ops: [op] };
      const rendered = await renderScene(scene, { format: "png" });
      const pixels = await decodeRendered(rendered);
      let ink = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (let y = 0; y < 300; y += 1) {
        for (let x = 0; x < 300; x += 1) {
          const [r, g, b] = pixelAt(pixels, x, y);
          if (r >= 245 && g >= 245 && b >= 245) continue;
          ink += 1;
          const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (distance < min) min = distance;
          if (distance > max) max = distance;
        }
      }
      return { ink, min, max };
    };

    const outside = await renderCurve({
      cx,
      cy,
      radius,
      startAngle: -140,
      endAngle: -40,
      side: "outside",
    });
    expect(outside.ink).toBeGreaterThan(50);
    expect(outside.min).toBeGreaterThanOrEqual(radius - sizePx * 0.6);
    expect(outside.max).toBeLessThanOrEqual(radius + sizePx * 1.1);

    const inside = await renderCurve({
      cx,
      cy,
      radius,
      startAngle: 140,
      endAngle: 40,
      side: "inside",
    });
    expect(inside.ink).toBeGreaterThan(50);
    expect(inside.min).toBeGreaterThanOrEqual(radius - sizePx * 1.1);
    expect(inside.max).toBeLessThanOrEqual(radius + sizePx * 0.6);
  });
});
