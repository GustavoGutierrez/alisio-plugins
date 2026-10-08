import { describe, expect, it } from "vitest";
import {
  type DesignSpecInput,
  type NormalizeResult,
  normalizeSpec,
} from "../src/core/design-spec.js";
import type { Registry } from "../src/core/registry.js";
import { makeFixtureRegistry } from "./helpers.js";

function specTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture-card",
    version: 1,
    family: "social",
    label: { es: "Tarjeta fija", en: "Fixture card" },
    layouts: {
      portrait: {
        slots: [
          { key: "title", role: "display", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, size: 72 },
        ],
      },
    },
    fields: [
      { key: "title", type: "text", required: true, maxChars: 10, overflow: "warn" },
      { key: "message", type: "text" },
      { key: "score", type: "number" },
      { key: "tags", type: "string[]", maxChars: 5 },
      { key: "values", type: "series" },
    ],
    defaultPalette: "alegria-botanica",
    defaultFontPair: "handwritten-readable",
    supports: { qr: true, illustration: false, images: false },
    ...overrides,
  };
}

let cachedRegistry: Promise<Registry> | undefined;

function registry(): Promise<Registry> {
  cachedRegistry ??= makeFixtureRegistry({
    templates: [
      specTemplate(),
      specTemplate({
        id: "fixture-no-qr",
        supports: { qr: false, illustration: false, images: false },
      }),
    ],
  });
  return cachedRegistry;
}

function baseInput(overrides: Partial<DesignSpecInput> = {}): DesignSpecInput {
  return {
    family: "social",
    templateId: "fixture-card",
    content: { title: "Hola" },
    ...overrides,
  };
}

function expectOk(result: NormalizeResult): Extract<NormalizeResult, { ok: true }> {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  return result;
}

function expectErrors(result: NormalizeResult): Extract<NormalizeResult, { ok: false }> {
  if (result.ok) throw new Error("Expected errors");
  return result;
}

describe("normalizeSpec", () => {
  it("applies size, palette, font pair, format and locale defaults", async () => {
    const result = expectOk(normalizeSpec(baseInput(), await registry()));
    expect(result.spec.sizeId).toBe("social-portrait");
    expect(result.spec.paletteId).toBe("alegria-botanica");
    expect(result.spec.fontPairId).toBe("handwritten-readable");
    expect(result.spec.format).toBe("png");
    expect(result.spec.locale).toBe("es");
    expect(result.spec.images).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("social-portrait");
  });

  it("rejects a family that does not match the template", async () => {
    const result = expectErrors(normalizeSpec(baseInput({ family: "chart" }), await registry()));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_SPEC", field: "family" }),
    );
  });

  it("returns compatible alternatives for an incompatible orientation", async () => {
    const result = expectErrors(
      normalizeSpec(baseInput({ sizeId: "social-square" }), await registry()),
    );
    const error = result.errors.find((entry) => entry.code === "INCOMPATIBLE_SIZE");
    expect(error).toBeDefined();
    expect(error?.field).toBe("sizeId");
    expect(error?.details?.alternatives).toEqual([
      "social-portrait",
      "social-tall",
      "story-vertical",
      "certificate-a4-portrait",
    ]);
  });

  it("reports unknown template, size, palette and font pair", async () => {
    const instance = await registry();
    const unknownTemplate = expectErrors(
      normalizeSpec(baseInput({ templateId: "nope" }), instance),
    );
    expect(unknownTemplate.errors[0]?.code).toBe("UNKNOWN_TEMPLATE");

    const unknownSize = expectErrors(normalizeSpec(baseInput({ sizeId: "nope" }), instance));
    expect(unknownSize.errors.some((entry) => entry.code === "UNKNOWN_SIZE")).toBe(true);

    const unknownPalette = expectErrors(normalizeSpec(baseInput({ paletteId: "nope" }), instance));
    expect(unknownPalette.errors.some((entry) => entry.code === "UNKNOWN_PALETTE")).toBe(true);

    const unknownFont = expectErrors(normalizeSpec(baseInput({ fontPairId: "nope" }), instance));
    expect(unknownFont.errors.some((entry) => entry.code === "UNKNOWN_FONT_PAIR")).toBe(true);
  });

  it("requires required fields and enforces maxChars", async () => {
    const instance = await registry();
    const missing = expectErrors(normalizeSpec(baseInput({ content: {} }), instance));
    expect(missing.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_SPEC", field: "content.title" }),
    );

    const tooLong = expectErrors(
      normalizeSpec(baseInput({ content: { title: "abcdefghijk" } }), instance),
    );
    expect(tooLong.errors[0]?.field).toBe("content.title");
    expect(tooLong.errors[0]?.details?.maxChars).toBe(10);
  });

  it("rejects unknown content keys", async () => {
    const result = expectErrors(
      normalizeSpec(baseInput({ content: { title: "Hola", bogus: "x" } }), await registry()),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_SPEC", field: "content.bogus" }),
    );
  });

  it("validates field types", async () => {
    const instance = await registry();
    const good = expectOk(
      normalizeSpec(
        baseInput({
          content: {
            title: "Hola",
            message: "todo bien",
            score: 7.5,
            tags: ["a", "bb"],
            values: [1, 2.5],
          },
        }),
        instance,
      ),
    );
    expect(good.spec.content.score).toBe(7.5);

    for (const content of [
      { title: "Hola", score: "alta" },
      { title: "Hola", tags: "no" },
      { title: "Hola", values: ["no"] },
      { title: "Hola", tags: ["demasiado"] },
    ]) {
      const result = expectErrors(normalizeSpec(baseInput({ content }), instance));
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("accepts rich chart series with labels, nulls and negative values", async () => {
    const instance = await registry();
    const rich = expectOk(
      normalizeSpec(
        baseInput({
          content: {
            title: "Hola",
            values: [{ label: "2025", values: [1, null, 3.5] }, { values: [-2, 4] }],
          },
        }),
        instance,
      ),
    );
    expect(rich.spec.content.values).toEqual([
      { label: "2025", values: [1, null, 3.5] },
      { values: [-2, 4] },
    ]);

    for (const values of [
      [{ label: 7, values: [1] }],
      [{ values: "no" }],
      [{ values: [1, "x"] }],
      [1, { values: [2] }],
    ]) {
      const invalid = expectErrors(
        normalizeSpec(baseInput({ content: { title: "Hola", values } }), instance),
      );
      expect(invalid.errors.some((error) => error.field === "content.values")).toBe(true);
    }
  });

  it("rejects qr and images on unsupported templates", async () => {
    const instance = await registry();
    const qr = expectErrors(
      normalizeSpec(
        baseInput({
          templateId: "fixture-no-qr",
          qr: { payload: "https://example.com" },
        }),
        instance,
      ),
    );
    expect(qr.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_SPEC", field: "qr" }),
    );

    const images = expectErrors(
      normalizeSpec(baseInput({ images: [{ id: "logo", path: "assets/logo.png" }] }), instance),
    );
    expect(images.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_SPEC", field: "images" }),
    );
  });

  it("validates seed, date, format and locale", async () => {
    const instance = await registry();
    const ok = expectOk(
      normalizeSpec(
        baseInput({
          seed: 42,
          date: "2024-02-29",
          format: "jpeg",
          locale: "en",
          qr: { payload: "https://example.com", ecc: "Q" },
        }),
        instance,
      ),
    );
    expect(ok.spec.seed).toBe(42);
    expect(ok.spec.date).toBe("2024-02-29");
    expect(ok.spec.qr).toEqual({ payload: "https://example.com", ecc: "Q" });

    const badSeed = expectErrors(normalizeSpec(baseInput({ seed: 1.5 }), instance));
    expect(badSeed.errors[0]?.field).toBe("seed");

    for (const date of ["2026-02-31", "2026-13-01", "31-12-2026"]) {
      const badDate = expectErrors(normalizeSpec(baseInput({ date }), instance));
      expect(badDate.errors[0]?.field).toBe("date");
    }

    const badFormat = expectErrors(
      normalizeSpec(baseInput({ format: "gif" as DesignSpecInput["format"] }), instance),
    );
    expect(badFormat.errors[0]?.field).toBe("format");
    const badLocale = expectErrors(
      normalizeSpec(baseInput({ locale: "fr" as DesignSpecInput["locale"] }), instance),
    );
    expect(badLocale.errors[0]?.field).toBe("locale");
  });
});
