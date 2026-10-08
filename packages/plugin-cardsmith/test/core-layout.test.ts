import { describe, expect, it } from "vitest";
import { type NormalizedSpec, normalizeSpec } from "../src/core/design-spec.js";
import { baseMarginPx, composeScene } from "../src/core/layout.js";
import { buildQrOp } from "../src/core/qr.js";
import type { Registry } from "../src/core/registry.js";
import type { PathOp, QrOp, RectOp, TextOp } from "../src/core/scene.js";
import { fakeMeasurer, makeFixtureRegistry } from "./helpers.js";

const LAYOUT_TEMPLATE: Record<string, unknown> = {
  id: "fixture-layout",
  version: 1,
  family: "social",
  label: { es: "Compuesta", en: "Composed" },
  layouts: {
    portrait: {
      background: "$background",
      decor: [{ assetId: "sparkle-basic", box: { x: 0, y: 0, w: 1, h: 1 } }],
      illustration: { box: { x: 0.05, y: 0.55, w: 0.9, h: 0.3 }, defaultId: "sparkle-basic" },
      qr: { box: { x: 0.75, y: 0.05, w: 0.2, h: 0.2 } },
      slots: [
        {
          key: "title",
          role: "display",
          box: { x: 0.1, y: 0.1, w: 0.8, h: 0.15 },
          size: 72,
          align: "center",
          valign: "middle",
          maxLines: 1,
        },
        {
          key: "message",
          role: "body",
          box: { x: 0.1, y: 0.3, w: 0.8, h: 0.2 },
          size: 36,
          maxLines: 1,
        },
        {
          key: "score",
          role: "bodyStrong",
          box: { x: 0.1, y: 0.85, w: 0.8, h: 0.1 },
          size: 24,
        },
      ],
    },
  },
  fields: [
    { key: "title", type: "text", required: true, overflow: "warn" },
    { key: "message", type: "text", overflow: "error" },
    { key: "score", type: "number" },
  ],
  defaultPalette: "alegria-botanica",
  defaultFontPair: "handwritten-readable",
  supports: { qr: true, illustration: true, images: false },
};

let cachedRegistry: Promise<Registry> | undefined;

function registry(): Promise<Registry> {
  cachedRegistry ??= makeFixtureRegistry({ templates: [LAYOUT_TEMPLATE] });
  return cachedRegistry;
}

async function compose(content: Record<string, unknown>, sizeId?: string) {
  const instance = await registry();
  const result = normalizeSpec(
    {
      family: "social",
      templateId: "fixture-layout",
      content,
      qr: { payload: "https://example.com" },
      ...(sizeId === undefined ? {} : { sizeId }),
    },
    instance,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const spec: NormalizedSpec = result.spec;
  const palette = instance.palette(spec.paletteId);
  return composeScene(instance.template(spec.templateId), "portrait", spec, palette, instance, {
    measurer: fakeMeasurer,
  });
}

describe("composeScene", () => {
  it("composes in background, decor, illustration, qr, text order with resolved tokens", async () => {
    const { scene } = await compose({ title: "Hola mundo", message: "Qué tal", score: 7 });
    expect(scene.width).toBe(1080);
    expect(scene.height).toBe(1350);
    expect(scene.background).toBe("#FFF6ED");
    expect(scene.ops.map((op) => op.op)).toEqual([
      "path",
      "path",
      "path",
      "path",
      "rect",
      "path",
      "path",
      "path",
      "path",
      "rect",
      "qr",
      "text",
      "text",
      "text",
    ]);

    const decorFill = scene.ops[0] as PathOp;
    expect(decorFill.fill).toBe("#FFC400");
    expect(decorFill.d.startsWith("M 540 199.8")).toBe(true);
    const decorStroke = scene.ops[1] as PathOp;
    expect(decorStroke.stroke).toBe("#181818");
    expect(decorStroke.strokeWidth).toBe(43.2);
    const decorCircle = scene.ops[2] as PathOp;
    expect(decorCircle.d.startsWith("M 831.6 351")).toBe(true);
    expect(decorCircle.d).toContain("A 54 54");
    const decorEllipse = scene.ops[3] as PathOp;
    expect(decorEllipse.d.startsWith("M 140.4 977.4")).toBe(true);
    const decorRect = scene.ops[4] as RectOp;
    expect(decorRect).toMatchObject({ x: 777.6, y: 934.2, w: 108, h: 108 });
    expect(decorRect.radius).toBeCloseTo(32.4, 10);
    expect(decorRect.fill).toBe("#FFC400");

    const illustrationPath = scene.ops[5] as PathOp;
    expect(illustrationPath.d.startsWith("M 540 766.8")).toBe(true);

    const qr = scene.ops[10] as QrOp;
    const expected = buildQrOp("https://example.com", 216, {
      palette: (await registry()).palette("alegria-botanica"),
    });
    expect(qr.matrix).toEqual(expected.matrix);
    expect(qr.boxSize).toBe(expected.boxSize);
    expect(qr.x).toBe(Math.round(810 + (216 - expected.boxSize) / 2));
    expect(qr.y).toBe(Math.round(67.5 + (270 - expected.boxSize) / 2));

    const title = scene.ops[11] as TextOp;
    expect(title.text).toBe("Hola mundo");
    expect(title.font).toEqual({
      alias: "CardsmithPatrickHand400",
      family: "Patrick Hand",
      weight: 400,
    });
    expect(title.color).toBe("#181818");
    expect(title.sizePx).toBe(72);
    expect(title.x).toBe(540);
    expect(title.y).toBe(236.25);
    expect(title.align).toBe("center");
    expect(title.valign).toBe("middle");
    expect(title.lineHeight).toBe(90);

    const message = scene.ops[12] as TextOp;
    expect(message.font.alias).toBe("CardsmithInter400");
    expect(message.x).toBe(108);
    expect(message.y).toBe(405);

    const score = scene.ops[13] as TextOp;
    expect(score.text).toBe("7");
    expect(score.font.alias).toBe("CardsmithInter600");
    expect(score.x).toBe(108);
    expect(score.y).toBe(1147.5);
  });

  it("honors the story safe area for content zones", async () => {
    const { scene } = await compose({ title: "Hola", message: "Qué tal" }, "story-vertical");
    expect(scene.width).toBe(1080);
    expect(scene.height).toBe(1920);
    const title = scene.ops.find((op) => op.op === "text") as TextOp;
    expect(title.x).toBe(540);
    expect(title.y).toBe(498.5);
    const qr = scene.ops.find((op) => op.op === "qr") as QrOp;
    expect(qr.x).toBeGreaterThanOrEqual(770);
    expect(qr.y).toBeGreaterThanOrEqual(321);
    expect(qr.x + qr.boxSize).toBeLessThanOrEqual(954);
    expect(qr.y + qr.boxSize).toBeLessThanOrEqual(605);
  });

  it("throws TEXT_OVERFLOW for an error field and keeps warn fields complete", async () => {
    let thrown: unknown;
    try {
      await compose({ title: "Hola", message: "x".repeat(400), score: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "TEXT_OVERFLOW" });
    expect((thrown as { details?: Record<string, unknown> }).details?.field).toBe("message");

    const { scene, warnings } = await compose({
      title: "y".repeat(200),
      message: "Qué tal",
      score: 1,
    });
    expect(warnings.some((warning) => warning.includes('"title"'))).toBe(true);
    expect(warnings.some((warning) => warning.includes("overflow"))).toBe(true);
    const title = scene.ops.find((op) => op.op === "text") as TextOp;
    expect(title.text).toBe("y".repeat(200));
    expect(title.lines.join("")).toBe("y".repeat(200));
    expect(title.sizePx).toBe(18);
  });

  it("is deterministic for identical inputs", async () => {
    const content = { title: "Hola mundo", message: "Qué tal", score: 7 };
    const first = await compose(content);
    const second = await compose(content);
    expect(second.scene).toEqual(first.scene);
    expect(second.warnings).toEqual(first.warnings);
    expect(JSON.stringify(second.scene)).toBe(JSON.stringify(first.scene));
  });

  it("exposes the base margin helper", () => {
    expect(baseMarginPx(1080, 1080)).toBeCloseTo(64.8, 10);
    expect(baseMarginPx(1080, 1350)).toBeCloseTo(64.8, 10);
    expect(baseMarginPx(1920, 1080)).toBeCloseTo(64.8, 10);
  });
});
