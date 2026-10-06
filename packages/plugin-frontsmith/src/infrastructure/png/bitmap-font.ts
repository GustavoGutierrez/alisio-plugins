import type { PngImage } from "../../domain/fidelity/image.js";

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

const row = (bits: string): number => Number.parseInt(bits, 2);

/** 5x7 glyphs, one row per entry, most significant bit on the left. ASCII only. */
const GLYPHS: Record<string, number[]> = Object.fromEntries(
  Object.entries({
    A: "01110 10001 10001 11111 10001 10001 10001",
    B: "11110 10001 10001 11110 10001 10001 11110",
    C: "01110 10001 10000 10000 10000 10001 01110",
    D: "11110 10001 10001 10001 10001 10001 11110",
    E: "11111 10000 10000 11110 10000 10000 11111",
    F: "11111 10000 10000 11110 10000 10000 10000",
    G: "01110 10001 10000 10111 10001 10001 01111",
    H: "10001 10001 10001 11111 10001 10001 10001",
    I: "01110 00100 00100 00100 00100 00100 01110",
    J: "00111 00010 00010 00010 00010 10010 01100",
    K: "10001 10010 10100 11000 10100 10010 10001",
    L: "10000 10000 10000 10000 10000 10000 11111",
    M: "10001 11011 10101 10101 10001 10001 10001",
    N: "10001 10001 11001 10101 10011 10001 10001",
    O: "01110 10001 10001 10001 10001 10001 01110",
    P: "11110 10001 10001 11110 10000 10000 10000",
    Q: "01110 10001 10001 10001 10101 10010 01101",
    R: "11110 10001 10001 11110 10100 10010 10001",
    S: "01111 10000 10000 01110 00001 00001 11110",
    T: "11111 00100 00100 00100 00100 00100 00100",
    U: "10001 10001 10001 10001 10001 10001 01110",
    V: "10001 10001 10001 10001 10001 01010 00100",
    W: "10001 10001 10001 10101 10101 10101 01010",
    X: "10001 10001 01010 00100 01010 10001 10001",
    Y: "10001 10001 01010 00100 00100 00100 00100",
    Z: "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110",
    "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111",
    "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010",
    "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110",
    "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110",
    "9": "01110 10001 10001 01111 00001 00010 01100",
    " ": "00000 00000 00000 00000 00000 00000 00000",
    "-": "00000 00000 00000 11111 00000 00000 00000",
    ".": "00000 00000 00000 00000 00000 01100 01100",
    ":": "00000 01100 01100 00000 01100 01100 00000",
    "/": "00001 00001 00010 00100 01000 10000 10000",
    _: "00000 00000 00000 00000 00000 00000 11111",
    "(": "00010 00100 01000 01000 01000 00100 00010",
    ")": "01000 00100 00010 00010 00010 00100 01000",
    "%": "11000 11001 00010 00100 01000 10011 00011",
  }).map(([glyph, rows]) => [glyph, rows.split(" ").map(row)]),
);

/** Drawn for any character outside the table (the font is ASCII only). */
const PLACEHOLDER = "11111 10001 10001 10001 10001 10001 11111".split(" ").map(row);

export const textWidth = (text: string, scale: number): number =>
  text.length === 0 ? 0 : (text.length * GLYPH_WIDTH + (text.length - 1)) * scale;

/** Draw `text` with its top-left corner at (x, y); pixels outside the image are skipped. */
export function drawText(
  image: PngImage,
  x: number,
  y: number,
  text: string,
  color: [number, number, number, number],
  scale = 1,
): void {
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char.toUpperCase()] ?? PLACEHOLDER;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1)
      for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
        if (((glyph[gy] as number) >> (GLYPH_WIDTH - 1 - gx)) & 1) {
          for (let sy = 0; sy < scale; sy += 1)
            for (let sx = 0; sx < scale; sx += 1) {
              const px = cursor + gx * scale + sx;
              const py = y + gy * scale + sy;
              if (px >= 0 && py >= 0 && px < image.width && py < image.height)
                image.data.set(color, (py * image.width + px) * 4);
            }
        }
      }
    cursor += (GLYPH_WIDTH + 1) * scale;
  }
}
