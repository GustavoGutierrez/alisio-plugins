import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { Scene, SceneOp } from "../src/core/scene.js";
import { RENDERER_VERSION, renderScene } from "../src/renderers/skia.js";
import { captureAsyncError } from "./helpers.js";
import { countInk, decodeRendered, fontRoleEntries, isNear, pixelAt } from "./render-helpers.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function solidImage(width: number, height: number, color: string) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return loadImage(canvas.toBuffer("image/png"));
}

function simpleScene(): Scene {
  const role = fontRoleEntries()[0];
  if (role === undefined) throw new Error("No font roles available");
  return {
    width: 320,
    height: 200,
    background: "#fff6ed",
    ops: [
      { op: "rect", x: 16, y: 16, w: 120, h: 60, fill: "#ffc400", radius: 12 },
      { op: "path", d: "M 160 20 L 220 80 L 160 80 Z", fill: "#f600a9" },
      {
        op: "text",
        text: "Cardsmith ñ áéíóú",
        x: 160,
        y: 140,
        font: { alias: role.alias, family: role.family, weight: role.weight },
        sizePx: 26,
        color: "#181818",
        align: "center",
        valign: "middle",
        lineHeight: 32,
        lines: ["Cardsmith ñ áéíóú"],
        maxWidth: 280,
      },
    ],
  };
}

describe("renderScene", () => {
  it("renders text with every font role alias and Spanish glyphs", async () => {
    const roles = fontRoleEntries();
    expect(roles.length).toBeGreaterThanOrEqual(8);
    const ops: SceneOp[] = roles.map((role, index) => ({
      op: "text",
      text: `ñ áéíóú ¿¡ $ ${role.alias}`,
      x: 16,
      y: 26 + index * 40,
      font: { alias: role.alias, family: role.family, weight: role.weight },
      sizePx: 24,
      color: "#111111",
      lineHeight: 30,
      lines: [`ñ áéíóú ¿¡ $ ${role.alias}`],
      maxWidth: 600,
    }));
    const scene: Scene = {
      width: 640,
      height: 26 + roles.length * 40 + 14,
      background: "#ffffff",
      ops,
    };
    const rendered = await renderScene(scene, { format: "png" });
    expect(rendered.mimeType).toBe("image/png");
    expect(rendered.width).toBe(scene.width);
    expect(rendered.height).toBe(scene.height);
    expect(rendered.scale).toBe(1);
    expect(Array.from(rendered.bytes.slice(0, 8))).toEqual(PNG_MAGIC);
    expect(rendered.bytes.length).toBeGreaterThan(1000);

    const image = await loadImage(Buffer.from(rendered.bytes));
    expect(image.width).toBe(scene.width);
    expect(image.height).toBe(scene.height);

    const pixels = await decodeRendered(rendered);
    for (const [index, role] of roles.entries()) {
      const region = { x: 16, y: 10 + index * 40, w: 600, h: 34 };
      expect(countInk(pixels, region), `no pixels for alias ${role.alias}`).toBeGreaterThan(0);
    }
  });

  it("is byte-identical across renders for PNG and JPEG", async () => {
    const scene = simpleScene();
    const pngFirst = await renderScene(scene, { format: "png" });
    const pngSecond = await renderScene(scene, { format: "png" });
    expect(pngFirst.bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(pngFirst.bytes).equals(Buffer.from(pngSecond.bytes))).toBe(true);

    const jpegFirst = await renderScene(scene, { format: "jpeg", jpegQuality: 85 });
    const jpegSecond = await renderScene(scene, { format: "jpeg", jpegQuality: 85 });
    expect(jpegFirst.bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(jpegFirst.bytes).equals(Buffer.from(jpegSecond.bytes))).toBe(true);
  });

  it("encodes JPEG with an opaque background and magic bytes", async () => {
    const rendered = await renderScene(simpleScene(), { format: "jpeg", jpegQuality: 80 });
    expect(rendered.mimeType).toBe("image/jpeg");
    expect(Array.from(rendered.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    const image = await loadImage(Buffer.from(rendered.bytes));
    expect(image.width).toBe(320);
    expect(image.height).toBe(200);
    const pixels = await decodeRendered(rendered);
    expect(pixelAt(pixels, 2, 2)[3]).toBe(255);
  });

  it("scales preview output while keeping scene coordinates", async () => {
    const rendered = await renderScene(simpleScene(), { format: "png", scale: 0.35 });
    expect(rendered.width).toBe(Math.round(320 * 0.35));
    expect(rendered.height).toBe(Math.round(200 * 0.35));
    expect(rendered.scale).toBe(0.35);
    const image = await loadImage(Buffer.from(rendered.bytes));
    expect(image.width).toBe(112);
    expect(image.height).toBe(70);
    const pixels = await decodeRendered(rendered);
    expect(isNear(pixelAt(pixels, 2, 2), [255, 246, 237])).toBe(true);
  });

  it("throws UNKNOWN_ASSET for an image ref without input", async () => {
    const scene: Scene = {
      width: 100,
      height: 100,
      background: "#ffffff",
      ops: [{ op: "image", ref: "missing", x: 0, y: 0, w: 50, h: 50 }],
    };
    const error = await captureAsyncError(() => renderScene(scene, { format: "png" }));
    expect(error.code).toBe("UNKNOWN_ASSET");
    expect(error.details?.ref).toBe("missing");
  });

  it("rejects an oversized scene before allocating a canvas", async () => {
    const scene: Scene = { width: 4000, height: 4000, background: "#ffffff", ops: [] };
    const error = await captureAsyncError(() => renderScene(scene, { format: "png" }));
    expect(error.code).toBe("LIMIT_EXCEEDED");
  });

  it("applies alpha, group translation and circle clipping with expected pixels", async () => {
    const green = await solidImage(40, 40, "#00c853");
    const scene: Scene = {
      width: 260,
      height: 120,
      background: "#ffffff",
      ops: [
        { op: "rect", x: 10, y: 10, w: 40, h: 40, fill: "#ff0000", alpha: 0.5 },
        {
          op: "group",
          translateX: 60,
          translateY: 10,
          children: [{ op: "rect", x: 0, y: 0, w: 40, h: 40, fill: "#0000ff" }],
        },
        { op: "image", ref: "green", x: 120, y: 10, w: 40, h: 40, fit: "cover", round: "circle" },
        {
          op: "group",
          translateX: 180,
          translateY: 10,
          alpha: 0.5,
          children: [{ op: "rect", x: 0, y: 0, w: 40, h: 40, fill: "#000000" }],
        },
      ],
    };
    const rendered = await renderScene(scene, {
      format: "png",
      images: new Map([["green", green]]),
    });
    const pixels = await decodeRendered(rendered);

    expect(isNear(pixelAt(pixels, 30, 30), [255, 128, 128], 4)).toBe(true);
    expect(isNear(pixelAt(pixels, 80, 30), [0, 0, 255], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 140, 30), [0, 200, 83], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 122, 12), [255, 255, 255], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 158, 48), [255, 255, 255], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 200, 30), [128, 128, 128], 4)).toBe(true);
  });

  it("rotates a group around the canvas center with a pixel proof", async () => {
    const scene: Scene = {
      width: 120,
      height: 120,
      background: "#ffffff",
      ops: [
        {
          op: "group",
          rotateDeg: 90,
          children: [{ op: "rect", x: 5, y: 5, w: 100, h: 10, fill: "#ff0000" }],
        },
      ],
    };
    const rendered = await renderScene(scene, { format: "png" });
    const pixels = await decodeRendered(rendered);
    // The horizontal strip becomes a vertical one after rotating 90° around (60, 60).
    expect(isNear(pixelAt(pixels, 110, 60), [255, 0, 0], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 10, 60), [255, 255, 255], 3)).toBe(true);
    expect(isNear(pixelAt(pixels, 60, 10), [255, 255, 255], 3)).toBe(true);
  });

  it("blends text alpha into the background with expected pixels", async () => {
    const role = fontRoleEntries()[0];
    if (role === undefined) throw new Error("No font roles available");
    const scene: Scene = {
      width: 160,
      height: 120,
      background: "#ffffff",
      ops: [
        {
          op: "text",
          text: "H",
          x: 80,
          y: 60,
          font: { alias: role.alias, family: role.family, weight: role.weight },
          sizePx: 72,
          color: "#000000",
          align: "center",
          valign: "middle",
          lineHeight: 80,
          lines: ["H"],
          maxWidth: 160,
          alpha: 0.5,
        },
      ],
    };
    const pixels = await decodeRendered(await renderScene(scene, { format: "png" }));
    let darkestRed = 255;
    for (let y = 0; y < pixels.height; y += 1) {
      for (let x = 0; x < pixels.width; x += 1) {
        darkestRed = Math.min(darkestRed, pixelAt(pixels, x, y)[0]);
      }
    }
    // Opaque glyph pixels blend 50% black over white: ~128, never 0 and never white.
    expect(darkestRed).toBeGreaterThan(100);
    expect(darkestRed).toBeLessThan(160);
  });

  it("exposes the renderer version", () => {
    expect(RENDERER_VERSION).toBe("1.0.0");
  });
});
