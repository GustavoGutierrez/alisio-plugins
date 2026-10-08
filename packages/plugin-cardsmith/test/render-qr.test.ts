import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { buildQrOp } from "../src/core/qr.js";
import type { QrOp, Scene } from "../src/core/scene.js";
import { renderScene } from "../src/renderers/skia.js";
import { captureAsyncError } from "./helpers.js";
import { decodeRendered, isNear, pixelAt } from "./render-helpers.js";

describe("QR rendering", () => {
  it("round-trips the payload through a real PNG decode with jsQR", async () => {
    const payload = "https://example.com/cardsmith?src=qr";
    const op = buildQrOp(payload, 480);
    const scene: Scene = {
      width: 520,
      height: 520,
      background: "#ffffff",
      ops: [{ ...op, x: 20, y: 20 }],
    };
    const rendered = await renderScene(scene, { format: "png" });
    const pixels = await decodeRendered(rendered);
    const decoded = jsQR(pixels.data, pixels.width, pixels.height);
    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(payload);
  });

  it("keeps a light quiet zone and integer-aligned dark modules", async () => {
    const op = buildQrOp("https://example.com", 480);
    const scene: Scene = {
      width: 520,
      height: 520,
      background: "#ffffff",
      ops: [{ ...op, x: 20, y: 20 }],
    };
    const rendered = await renderScene(scene, { format: "png" });
    const pixels = await decodeRendered(rendered);

    const moduleCount = op.matrix.length;
    const modulePx = Math.floor(op.boxSize / (moduleCount + 8));
    expect(modulePx).toBeGreaterThanOrEqual(4);

    const corner = 20 + Math.floor(modulePx / 2);
    const far = 20 + op.boxSize - 1 - Math.floor(modulePx / 2);
    for (const [x, y] of [
      [corner, corner],
      [far, corner],
      [corner, far],
      [far, far],
    ] as Array<[number, number]>) {
      expect(isNear(pixelAt(pixels, x, y), [255, 255, 255], 2), `quiet zone at ${x},${y}`).toBe(
        true,
      );
    }

    // the top-left finder module is dark and drawn at an integer module offset
    const darkX = 20 + 4 * modulePx + Math.floor(modulePx / 2);
    const darkY = 20 + 4 * modulePx + Math.floor(modulePx / 2);
    expect(isNear(pixelAt(pixels, darkX, darkY), [17, 17, 17], 6)).toBe(true);
  });

  it("paints the full box light even when the module grid does not fill it", async () => {
    const base = buildQrOp("https://example.com", 480);
    const op: QrOp = { ...base, boxSize: base.boxSize + 5, x: 20, y: 20 };
    const scene: Scene = {
      width: 520,
      height: 520,
      background: "#ffffff",
      ops: [op],
    };
    const rendered = await renderScene(scene, { format: "png" });
    const pixels = await decodeRendered(rendered);
    const modulePx = Math.floor(op.boxSize / (base.matrix.length + 8));
    expect(modulePx).toBe(Math.floor(base.boxSize / (base.matrix.length + 8)));
    // outside the integer module grid but inside boxSize: still light
    const stripX = 20 + op.boxSize - 2;
    const stripY = 20 + 2 * modulePx;
    expect(isNear(pixelAt(pixels, stripX, stripY), [255, 255, 255], 2)).toBe(true);
  });

  it("rejects a QR op that is too dense for its box", async () => {
    const matrix = Array.from({ length: 60 }, () => Array.from({ length: 60 }, () => true));
    const dense: QrOp = {
      op: "qr",
      matrix,
      x: 0,
      y: 0,
      boxSize: 100,
      dark: "#111111",
      light: "#ffffff",
    };
    const scene: Scene = { width: 120, height: 120, background: "#ffffff", ops: [dense] };
    const error = await captureAsyncError(() => renderScene(scene, { format: "png" }));
    expect(error.code).toBe("QR_TOO_DENSE");
    expect(error.details?.modulePx).toBe(1);
    expect(error.details?.minModulePx).toBe(4);
  });

  it("keeps the quiet zone light over a colored scene background", async () => {
    const op = buildQrOp("CARDSMITH", 240);
    const scene: Scene = {
      width: 300,
      height: 300,
      background: "#fff3de",
      ops: [{ ...op, x: 30, y: 30 }],
    };
    const rendered = await renderScene(scene, { format: "png" });
    const pixels = await decodeRendered(rendered);
    const modulePx = Math.floor(op.boxSize / (op.matrix.length + 8));
    const sample = 30 + Math.floor(modulePx / 2);
    expect(isNear(pixelAt(pixels, sample, sample), [255, 255, 255], 2)).toBe(true);
    expect(isNear(pixelAt(pixels, 5, 5), [255, 243, 222], 2)).toBe(true);
  });
});
