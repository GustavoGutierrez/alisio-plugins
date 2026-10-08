import { describe, expect, it } from "vitest";
import { type FitResult, fitText, type ResolvedFont } from "../src/core/typography.js";
import { captureError, fakeMeasurer } from "./helpers.js";

const FONT: ResolvedFont = { alias: "CardsmithInter400", family: "Inter", weight: 400 };

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function expectNoSilentTruncation(result: FitResult, original: string): void {
  expect(compact(result.lines.join(""))).toBe(compact(original));
}

function lineWidths(result: FitResult): number[] {
  return result.lines.map((line) => line.length * result.sizePx * 0.55);
}

describe("fitText", () => {
  it("fits Spanish text with ñ, accents and opening punctuation", () => {
    const text = "¡Buenos días! ¿Cómo estás, ñandú? áéíóú";
    const result = fitText(
      {
        text,
        font: FONT,
        maxWidth: 400,
        maxHeight: 400,
        maxSize: 40,
        minSize: 8,
        maxLines: 4,
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(false);
    expect(result.sizePx).toBe(40);
    expect(result.lines.join(" ")).toBe(text);
    expect(result.lineHeight).toBe(50);
    expect(result.width).toBeLessThanOrEqual(400);
  });

  it("shrinks a long title until it fits and keeps every character", () => {
    const text = "La aventura extraordinaria de un viajero incansable por tierras lejanas";
    const result = fitText(
      {
        text,
        font: FONT,
        maxWidth: 500,
        maxHeight: 260,
        maxSize: 60,
        minSize: 12,
        maxLines: 3,
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(false);
    expect(result.sizePx).toBeLessThan(60);
    expect(result.sizePx).toBeGreaterThanOrEqual(12);
    expect(result.lines.length).toBeLessThanOrEqual(3);
    expect(result.lines.join(" ")).toBe(text);
    for (const width of lineWidths(result)) expect(width).toBeLessThanOrEqual(500);
  });

  it("honors explicit newlines as hard breaks", () => {
    const text = "Primera línea\nSegunda línea";
    const result = fitText(
      {
        text,
        font: FONT,
        maxWidth: 1000,
        maxHeight: 500,
        maxSize: 40,
        minSize: 10,
        maxLines: 4,
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(false);
    expect(result.lines.join("\n")).toBe(text);
    expect(result.sizePx).toBe(40);

    const withBlankLine = "Arriba\n\nAbajo";
    const blank = fitText(
      {
        text: withBlankLine,
        font: FONT,
        maxWidth: 1000,
        maxHeight: 500,
        maxSize: 40,
        minSize: 10,
        maxLines: 4,
      },
      fakeMeasurer,
    );
    expect(blank.lines.join("\n")).toBe(withBlankLine);
  });

  it("breaks a certificate-style single word by code points as a last resort", () => {
    const word = "MaríaFernandaGutiérrezRodríguezDeLaCruz";
    const result = fitText(
      {
        text: word,
        font: FONT,
        maxWidth: 300,
        maxHeight: 300,
        maxSize: 60,
        minSize: 10,
        maxLines: 3,
        breakPolicy: "word-then-char",
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(false);
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.length).toBeLessThanOrEqual(3);
    expect(result.lines.join("")).toBe(word);
    for (const width of lineWidths(result)) expect(width).toBeLessThanOrEqual(300);
  });

  it("preserves the full text when even minSize overflows", () => {
    const word = "a".repeat(400);
    const result = fitText(
      {
        text: word,
        font: FONT,
        maxWidth: 300,
        maxHeight: 1000,
        maxSize: 40,
        minSize: 10,
        maxLines: 1,
        breakPolicy: "word-then-char",
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(true);
    expect(result.sizePx).toBe(10);
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.join("")).toBe(word);
    expectNoSilentTruncation(result, word);
  });

  it("keeps a full word under the word policy and flags overflow instead of truncating", () => {
    const word = "ExtraordinarísimoInsuperable";
    const result = fitText(
      {
        text: word,
        font: FONT,
        maxWidth: 100,
        maxHeight: 500,
        maxSize: 40,
        minSize: 10,
        maxLines: 3,
        breakPolicy: "word",
      },
      fakeMeasurer,
    );
    expect(result.overflow).toBe(true);
    expect(result.lines.join("")).toBe(word);
  });

  it("keeps mixed long-word names intact", () => {
    const text = "Josefa Ramírez y Fernández de la Vega";
    const result = fitText(
      {
        text,
        font: FONT,
        maxWidth: 180,
        maxHeight: 400,
        maxSize: 48,
        minSize: 10,
        maxLines: 4,
        breakPolicy: "word-then-char",
      },
      fakeMeasurer,
    );
    expectNoSilentTruncation(result, text);
    if (!result.overflow) {
      expect(result.lines.length).toBeLessThanOrEqual(4);
      expect(result.height).toBeLessThanOrEqual(400);
      for (const width of lineWidths(result)) expect(width).toBeLessThanOrEqual(180);
    }
  });

  it("honors a custom line height ratio", () => {
    const result = fitText(
      {
        text: "línea",
        font: FONT,
        maxWidth: 1000,
        maxHeight: 1000,
        maxSize: 20,
        minSize: 20,
        maxLines: 2,
        lineHeightRatio: 1.5,
      },
      fakeMeasurer,
    );
    expect(result.lineHeight).toBe(30);
    expect(result.height).toBe(30);
  });

  it("rejects invalid requests", () => {
    const base = {
      text: "hola",
      font: FONT,
      maxWidth: 100,
      maxHeight: 100,
      maxSize: 20,
      minSize: 10,
      maxLines: 2,
    };
    expect(captureError(() => fitText({ ...base, maxWidth: 0 }, fakeMeasurer)).code).toBe(
      "INVALID_SPEC",
    );
    expect(captureError(() => fitText({ ...base, minSize: 30 }, fakeMeasurer)).code).toBe(
      "INVALID_SPEC",
    );
    expect(captureError(() => fitText({ ...base, maxLines: 0 }, fakeMeasurer)).code).toBe(
      "INVALID_SPEC",
    );
  });
});
