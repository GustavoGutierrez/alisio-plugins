import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  drawText,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  textWidth,
} from "../src/infrastructure/png/bitmap-font.js";
import { composeEvidence, downscale } from "../src/infrastructure/png/composite.js";
import { decodePng, PngError } from "../src/infrastructure/png/decode.js";
import { crc32, encodePng } from "../src/infrastructure/png/encode.js";
import { clonePng, encodeWithFilters, fillRect, solid } from "./helpers/png.js";

const fixture = (name: string): Uint8Array =>
  readFileSync(join(import.meta.dirname, "fixtures", "png", name));
/** The pixels the committed fixtures were generated from (an independent encoder). */
const px = (x: number, y: number): [number, number, number, number] => [
  (x * 30) % 256,
  (y * 30) % 256,
  (x * y * 7) % 256,
  (255 - x * 10) % 256,
];

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("decoder", () => {
  it("decodes colour type 6 with every filter type (committed fixture from an independent encoder)", () => {
    const image = decodePng(fixture("rgba-filters.png"));
    expect([image.width, image.height]).toEqual([8, 8]);
    for (let y = 0; y < 8; y += 1)
      for (let x = 0; x < 8; x += 1)
        expect([...image.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)], `${x},${y}`).toEqual(
          px(x, y),
        );
  });

  it("decodes colour type 2 and fills alpha with 255", () => {
    const image = decodePng(fixture("rgb-filters.png"));
    expect([image.width, image.height]).toEqual([6, 5]);
    for (let y = 0; y < 5; y += 1)
      for (let x = 0; x < 6; x += 1) {
        const [r, g, b] = px(x, y);
        expect([...image.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)], `${x},${y}`).toEqual(
          [r, g, b, 255],
        );
      }
  });

  it("decodes what the test helper encodes for every filter, both colour types", () => {
    const source = solid(7, 9);
    for (let y = 0; y < 9; y += 1)
      for (let x = 0; x < 7; x += 1) source.data.set(px(x, y), (y * 7 + x) * 4);
    for (const filter of [0, 1, 2, 3, 4]) {
      const rgba = decodePng(encodeWithFilters(source, 6, [filter]));
      expect([...rgba.data]).toEqual([...source.data]);
      const rgb = decodePng(encodeWithFilters(source, 2, [filter]));
      expect([...rgb.data].filter((_, i) => i % 4 !== 3)).toEqual(
        [...source.data].filter((_, i) => i % 4 !== 3),
      );
    }
  });

  it("refuses unsupported formats with their reason (spec 10.3: BLOCKED unsupported PNG)", () => {
    for (const [name, reason] of [
      ["gray.png", /colour type 0/],
      ["palette.png", /colour type 3/],
      ["rgb16.png", /bit depth 16/],
      ["interlaced.png", /interlaced/],
    ] as const) {
      let error: unknown;
      try {
        decodePng(fixture(name));
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(PngError);
      expect((error as PngError).kind).toBe("unsupported");
      expect((error as PngError).message).toMatch(/^unsupported PNG: /);
      expect((error as PngError).message).toMatch(reason);
    }
  });

  it("reports damaged files as corrupt, never as an image", () => {
    expect(() => decodePng(fixture("truncated.png"))).toThrow(PngError);
    expect(() => decodePng(new TextEncoder().encode("not a png at all"))).toThrow(/not a PNG/);
    const flipped = Uint8Array.from(fixture("rgba-filters.png"));
    flipped[40] = (flipped[40] as number) ^ 0xff;
    expect(() => decodePng(flipped)).toThrow(/checksum|corrupt/);
    const huge = Uint8Array.from(fixture("rgba-filters.png"));
    new DataView(huge.buffer).setUint32(16, 100_000);
    expect(() => decodePng(huge)).toThrow(PngError);
  });
});

describe("encoder", () => {
  it("round-trips pixels exactly and is deterministic", () => {
    const image = solid(13, 7);
    for (let i = 0; i < image.data.length; i += 1) image.data[i] = (i * 37 + 11) & 255;
    const a = encodePng(image);
    const b = encodePng(image);
    expect([...a]).toEqual([...b]);
    const back = decodePng(a);
    expect([back.width, back.height]).toEqual([13, 7]);
    expect([...back.data]).toEqual([...image.data]);
    expect([...a.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("rejects an image whose data does not match its size", () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(4) })).toThrow(/size/);
    expect(() => encodePng({ width: 0, height: 2, data: new Uint8Array(0) })).toThrow();
  });
});

describe("bitmap font", () => {
  it("draws 5x7 ASCII glyphs and reports the text width", () => {
    expect([GLYPH_WIDTH, GLYPH_HEIGHT]).toEqual([5, 7]);
    expect(textWidth("ACTUAL", 1)).toBe(6 * 5 + 5);
    expect(textWidth("ACTUAL", 2)).toBe((6 * 5 + 5) * 2);
    const image = solid(40, 12);
    drawText(image, 1, 2, "A", [0, 0, 0, 255], 1);
    const dark = [...image.data].filter((_, i) => i % 4 === 0 && image.data[i] === 0).length;
    expect(dark).toBeGreaterThan(8);
    expect(dark).toBeLessThan(35);
    // The glyph stays inside its 5x7 cell.
    for (let y = 0; y < 12; y += 1)
      for (let x = 0; x < 40; x += 1)
        if (image.data[(y * 40 + x) * 4] === 0) {
          expect(x).toBeGreaterThanOrEqual(1);
          expect(x).toBeLessThan(6);
          expect(y).toBeGreaterThanOrEqual(2);
          expect(y).toBeLessThan(9);
        }
  });

  it("is ASCII only: other characters render as a placeholder box and never throw", () => {
    const image = solid(30, 10);
    expect(() => drawText(image, 0, 0, "é€", [0, 0, 0, 255], 1)).not.toThrow();
  });

  it("clips at the image edge", () => {
    const image = solid(4, 4);
    expect(() => drawText(image, 2, 2, "WWW", [0, 0, 0, 255], 1)).not.toThrow();
  });
});

describe("composite evidence image (spec 11.5)", () => {
  const reference = solid(120, 80);
  const actual = clonePng(reference);
  fillRect(actual, 10, 10, 20, 20, [0, 0, 0, 255]);

  it("puts reference, actual and diff side by side under a label strip within the width cap", () => {
    const result = composeEvidence({
      reference,
      actual,
      maxWidth: 2400,
      maxBytes: 2_000_000,
      channelTolerance: 0,
    });
    expect(result.scale).toBe(1);
    expect(result.image.width).toBeLessThanOrEqual(2400);
    expect(result.image.width).toBe(120 * 3 + 2 * 8);
    expect(result.image.height).toBe(24 + 80);
    const back = decodePng(result.png);
    expect([back.width, back.height]).toEqual([result.image.width, result.image.height]);
    expect(result.png.length).toBeLessThanOrEqual(2_000_000);
  });

  it("paints differing pixels magenta over a washed-out actual in the third panel", () => {
    const { image } = composeEvidence({
      reference,
      actual,
      maxWidth: 2400,
      maxBytes: 2_000_000,
      channelTolerance: 0,
    });
    const panelX = 2 * (120 + 8);
    const at = (x: number, y: number): number[] => [
      ...image.data.subarray(
        ((24 + y) * image.width + panelX + x) * 4,
        ((24 + y) * image.width + panelX + x) * 4 + 4,
      ),
    ];
    expect(at(15, 15)).toEqual([255, 0, 255, 255]);
    const same = at(100, 60);
    expect(same[0]).toBe(same[1]);
    expect(same[0]).toBeGreaterThan(200);
  });

  it("downscales by whole factors until the width fits and until the file fits the byte cap", () => {
    const wide = solid(1000, 200);
    const narrow = composeEvidence({
      reference: wide,
      actual: wide,
      maxWidth: 2400,
      maxBytes: 2_000_000,
      channelTolerance: 0,
    });
    expect(narrow.scale).toBe(2);
    expect(narrow.image.width).toBeLessThanOrEqual(2400);
    const noisy = solid(300, 300);
    let state = 2463534242;
    for (let i = 0; i < noisy.data.length; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noisy.data[i] = (state >>> 0) & 255;
    }
    const capped = composeEvidence({
      reference: noisy,
      actual: noisy,
      maxWidth: 2400,
      maxBytes: 40_000,
      channelTolerance: 0,
    });
    expect(capped.png.length).toBeLessThanOrEqual(40_000);
    expect(capped.scale).toBeGreaterThan(1);
  });

  it("handles inputs of different sizes by padding the smaller panel, and outlines region boxes", () => {
    const small = solid(60, 40);
    const result = composeEvidence({
      reference,
      actual: small,
      maxWidth: 2400,
      maxBytes: 2_000_000,
      channelTolerance: 0,
      regions: [{ x: 5, y: 5, width: 30, height: 20 }],
    });
    expect(result.image.height).toBe(24 + 80);
    const outline = [
      ...result.image.data.subarray(
        ((24 + 5) * result.image.width + 2 * 128 + 5) * 4,
        ((24 + 5) * result.image.width + 2 * 128 + 5) * 4 + 4,
      ),
    ];
    expect(outline).not.toEqual([255, 255, 255, 255]);
  });

  it("nearest-neighbour downscaling keeps exact pixels", () => {
    const image = solid(4, 4);
    fillRect(image, 0, 0, 2, 2, [10, 20, 30, 255]);
    const small = downscale(image, 2);
    expect([small.width, small.height]).toEqual([2, 2]);
    expect([...small.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...small.data.subarray(4, 8)]).toEqual([255, 255, 255, 255]);
    expect(downscale(image, 1)).toBe(image);
  });
});
