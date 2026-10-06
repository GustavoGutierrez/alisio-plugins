import { deflateSync } from "node:zlib";
import type { PngImage } from "../../src/infrastructure/png/decode.js";
import { crc32 } from "../../src/infrastructure/png/encode.js";

/** A solid RGBA image. */
export function solid(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [255, 255, 255, 255],
): PngImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** Paint a rectangle in place. */
export function fillRect(
  image: PngImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): void {
  for (let row = y; row < y + h; row += 1)
    for (let col = x; col < x + w; col += 1) image.data.set(rgba, (row * image.width + col) * 4);
}

export const clonePng = (image: PngImage): PngImage => ({
  ...image,
  data: Uint8Array.from(image.data),
});

const chunk = (type: string, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
};

/** A PNG with a chosen filter per row and colour type 2 or 6, for decoder tests. */
export function encodeWithFilters(
  image: PngImage,
  colorType: 2 | 6,
  filters: number[],
): Uint8Array {
  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = image.width * bpp;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < image.height; y += 1) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < image.width; x += 1)
      for (let c = 0; c < bpp; c += 1)
        row[x * bpp + c] = image.data[(y * image.width + x) * 4 + c] as number;
    rows.push(row);
  }
  const raw = new Uint8Array(image.height * (rowBytes + 1));
  let previous = new Uint8Array(rowBytes);
  rows.forEach((row, y) => {
    const filter = (filters[y % filters.length] as number) ?? 0;
    raw[y * (rowBytes + 1)] = filter;
    for (let i = 0; i < rowBytes; i += 1) {
      const a = i >= bpp ? (row[i - bpp] as number) : 0;
      const b = previous[i] as number;
      const c = i >= bpp ? (previous[i - bpp] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      raw[y * (rowBytes + 1) + 1 + i] = ((row[i] as number) - predictor) & 255;
    }
    previous = row;
  });
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = 8;
  header[9] = colorType;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
