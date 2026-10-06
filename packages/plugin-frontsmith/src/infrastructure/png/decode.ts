import { inflateSync } from "node:zlib";
import type { PngImage } from "../../domain/fidelity/image.js";
import { crc32 } from "./encode.js";

export type { PngImage };

/** `unsupported`: a valid PNG this codec does not read (spec 10.3: BLOCKED); `corrupt`: damaged data. */
export class PngError extends Error {
  constructor(
    readonly kind: "unsupported" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "PngError";
  }
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Pixels a screenshot may have; larger images are refused instead of exhausting memory. */
const MAX_PIXELS = 64_000_000;

const be32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)) >>>
  0;

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode an 8-bit, non-interlaced PNG of colour type 2 (RGB) or 6 (RGBA) with all five filters.
 * Everything else is `unsupported PNG: <reason>`; a damaged file is `corrupt`.
 */
export function decodePng(bytes: Uint8Array): PngImage {
  if (bytes.length < 8 || SIGNATURE.some((value, i) => bytes[i] !== value))
    throw new PngError("corrupt", "not a PNG file");
  let width = 0;
  let height = 0;
  let colorType = -1;
  let header = false;
  const idat: Uint8Array[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > bytes.length)
      throw new PngError("corrupt", `truncated ${type} chunk`);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== be32(bytes, offset + 8 + length))
      throw new PngError("corrupt", `checksum mismatch in ${type} chunk`);
    if (type === "IHDR") {
      if (length !== 13) throw new PngError("corrupt", "invalid IHDR");
      width = be32(body, 0);
      height = be32(body, 4);
      const bitDepth = body[8] as number;
      colorType = body[9] as number;
      const interlace = body[12] as number;
      header = true;
      if (bitDepth !== 8)
        throw new PngError("unsupported", `unsupported PNG: bit depth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6)
        throw new PngError("unsupported", `unsupported PNG: colour type ${colorType}`);
      if (interlace !== 0) throw new PngError("unsupported", "unsupported PNG: interlaced");
      if (width === 0 || height === 0 || width * height > MAX_PIXELS)
        throw new PngError("corrupt", `implausible size ${width}x${height}`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new PngError("corrupt", "missing IHDR");
  if (!ended || idat.length === 0) throw new PngError("corrupt", "missing image data");
  const compressed = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(compressed);
  } catch {
    throw new PngError("corrupt", "the image data cannot be decompressed");
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1))
    throw new PngError("corrupt", "image data has the wrong length");
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    if (filter > 4) throw new PngError("corrupt", `unknown filter type ${filter}`);
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= bpp ? (row[i - bpp] as number) : 0;
      const b = previous[i] as number;
      const c = i >= bpp ? (previous[i - bpp] as number) : 0;
      row[i] =
        (x +
          (filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c))) &
        255;
    }
    for (let px = 0; px < width; px += 1) {
      const target = (y * width + px) * 4;
      data[target] = row[px * bpp] as number;
      data[target + 1] = row[px * bpp + 1] as number;
      data[target + 2] = row[px * bpp + 2] as number;
      data[target + 3] = colorType === 6 ? (row[px * bpp + 3] as number) : 255;
    }
    [previous, row] = [row, previous];
  }
  return { width, height, data };
}
