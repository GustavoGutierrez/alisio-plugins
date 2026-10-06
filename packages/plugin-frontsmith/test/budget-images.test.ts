import { describe, expect, it } from "vitest";
import { readImageSize } from "../src/domain/budgets/image-size.js";

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

describe("image sizes from headers (spec 10.6)", () => {
  it("reads PNG IHDR", () => {
    const png = [
      0x89,
      ...ascii("PNG"),
      13,
      10,
      26,
      10,
      ...be32(13),
      ...ascii("IHDR"),
      ...be32(1200),
      ...be32(630),
      8,
      6,
      0,
      0,
      0,
    ];
    expect(readImageSize(Uint8Array.from(png))).toEqual({ width: 1200, height: 630 });
  });

  it("reads a JPEG start-of-frame after other segments", () => {
    const jpeg = [
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...be16(4),
      0,
      0,
      0xff,
      0xc0,
      ...be16(11),
      8,
      ...be16(480),
      ...be16(640),
      3,
      1,
      0x22,
      0,
    ];
    expect(readImageSize(Uint8Array.from(jpeg))).toEqual({ width: 640, height: 480 });
  });

  it("reads the three WebP flavours", () => {
    const riff = (kind: string, body: number[]): Uint8Array =>
      Uint8Array.from([
        ...ascii("RIFF"),
        ...le32(4 + body.length),
        ...ascii("WEBP"),
        ...ascii(kind),
        ...le32(body.length),
        ...body,
      ]);
    const lossy = riff("VP8 ", [
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      320 & 255,
      320 >> 8,
      200 & 255,
      200 >> 8,
      0,
      0,
      0,
      0,
    ]);
    expect(readImageSize(lossy)).toEqual({ width: 320, height: 200 });
    const bits = (300 - 1) | ((150 - 1) << 14);
    const lossless = riff("VP8L", [0x2f, ...le32(bits), 0, 0, 0, 0]);
    expect(readImageSize(lossless)).toEqual({ width: 300, height: 150 });
    const extended = riff("VP8X", [0, 0, 0, 0, ...le24(1023), ...le24(511), 0, 0, 0, 0]);
    expect(readImageSize(extended)).toEqual({ width: 1024, height: 512 });
  });

  it("reads the ispe box of an AVIF file", () => {
    const avif = [
      ...be32(24),
      ...ascii("ftyp"),
      ...ascii("avif"),
      0,
      0,
      0,
      0,
      ...ascii("avif"),
      ...be32(20),
      ...ascii("ispe"),
      0,
      0,
      0,
      0,
      ...be32(800),
      ...be32(600),
    ];
    expect(readImageSize(Uint8Array.from(avif))).toEqual({ width: 800, height: 600 });
  });

  it("returns nothing for unknown, empty or damaged data", () => {
    expect(readImageSize(new Uint8Array())).toBeUndefined();
    expect(
      readImageSize(Uint8Array.from(ascii("GIF89a............................"))),
    ).toBeUndefined();
    expect(
      readImageSize(Uint8Array.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeUndefined();
    expect(
      readImageSize(
        Uint8Array.from([
          0x89,
          ...ascii("PNG"),
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ]),
      ),
    ).toBeUndefined();
  });
});
