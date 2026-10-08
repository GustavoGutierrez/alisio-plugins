import { describe, expect, it } from "vitest";
import { buildQrOp, encodeQrMatrix } from "../src/core/qr.js";
import { captureError, makeFixtureRegistry } from "./helpers.js";

const PAYLOAD = "https://example.com";

describe("QR ops", () => {
  it("builds an integer-aligned matrix box with the four-module quiet zone", () => {
    const op = buildQrOp(PAYLOAD, 200);
    const modules = op.matrix.length;
    expect(modules).toBeGreaterThanOrEqual(21);
    expect(op.matrix.every((row) => row.length === modules)).toBe(true);
    expect(op.matrix.flat().some((cell) => cell)).toBe(true);

    const totalModules = modules + 2 * 4;
    const modulePx = op.boxSize / totalModules;
    expect(Number.isInteger(modulePx)).toBe(true);
    expect(modulePx).toBe(Math.floor(200 / totalModules));
    expect(modulePx).toBeGreaterThanOrEqual(4);
    expect(op.x).toBe(0);
    expect(op.y).toBe(0);
    expect(op.dark).toBe("#111111");
    expect(op.light).toBe("#ffffff");
  });

  it("throws QR_TOO_DENSE instead of shrinking modules below 4px", () => {
    const error = captureError(() => buildQrOp(PAYLOAD, 100));
    expect(error.code).toBe("QR_TOO_DENSE");
    expect(error.details?.minModulePx).toBe(4);
  });

  it("rejects empty and oversized payloads", () => {
    expect(captureError(() => buildQrOp("", 400)).code).toBe("QR_INVALID");
    expect(captureError(() => buildQrOp("a".repeat(3000), 400)).code).toBe("QR_INVALID");
    expect(captureError(() => encodeQrMatrix("")).code).toBe("QR_INVALID");
  });

  it("supports ECC Q and produces a matrix at least as large as M", () => {
    const medium = encodeQrMatrix(PAYLOAD, "M");
    const quartile = encodeQrMatrix(PAYLOAD, "Q");
    expect(quartile.length).toBeGreaterThanOrEqual(medium.length);
    const op = buildQrOp(PAYLOAD, 400, { ecc: "Q" });
    expect(op.matrix).toEqual(quartile);
  });

  it("keeps black-on-white ink unless a palette text color is clearly legible", async () => {
    const registry = await makeFixtureRegistry();
    const alegria = buildQrOp(PAYLOAD, 200, { palette: registry.palette("alegria-botanica") });
    expect(alegria.dark).toBe("#181818");
    const ocean = buildQrOp(PAYLOAD, 200, { palette: registry.palette("alisio-ocean") });
    expect(ocean.dark).toBe("#111111");
    expect(ocean.light).toBe("#ffffff");
  });

  it("rejects a non-positive box", () => {
    expect(captureError(() => buildQrOp(PAYLOAD, 0)).code).toBe("INVALID_SPEC");
  });
});
