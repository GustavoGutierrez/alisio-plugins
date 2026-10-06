/** Pixel dimensions read from file headers, with no decoding (spec 10.6). */
export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number): number => ((b[o] as number) << 8) | (b[o + 1] as number);
const u32be = (b: Uint8Array, o: number): number =>
  (((b[o] as number) << 24) |
    ((b[o + 1] as number) << 16) |
    ((b[o + 2] as number) << 8) |
    (b[o + 3] as number)) >>>
  0;
const u24le = (b: Uint8Array, o: number): number =>
  (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
const u16le = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8);
const ascii = (b: Uint8Array, o: number, n: number): string =>
  String.fromCharCode(...b.subarray(o, o + n));

function png(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): ImageSize | undefined {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return undefined;
    const marker = b[o + 1] as number;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    o += 2 + u16be(b, o + 2);
  }
  return undefined;
}

function webp(b: Uint8Array): ImageSize | undefined {
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 " && b.length >= 30)
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (kind === "VP8L" && b.length >= 25) {
    const bits =
      (b[21] as number) |
      ((b[22] as number) << 8) |
      ((b[23] as number) << 16) |
      ((b[24] as number) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X" && b.length >= 30)
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return undefined;
}

/** AVIF: the `ispe` property box holds the image width and height. */
function avif(b: Uint8Array): ImageSize | undefined {
  for (let o = 0; o + 16 <= b.length; o += 1)
    if (ascii(b, o, 4) === "ispe") return { width: u32be(b, o + 8), height: u32be(b, o + 12) };
  return undefined;
}

/** PNG, JPEG, WebP and AVIF headers; any other format (or a damaged file) is `undefined`. */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length > 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return png(bytes);
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.length > 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return webp(bytes);
  if (bytes.length > 16 && ascii(bytes, 4, 4) === "ftyp") return avif(bytes);
  return undefined;
}
