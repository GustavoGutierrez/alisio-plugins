import { describe, expect, it } from "vitest";
import {
  defaultSizeForFamily,
  SIZE_PRESETS,
  size,
  sizeOrientation,
  sizesForOrientation,
} from "../src/core/sizes.js";
import { captureError } from "./helpers.js";

const EXPECTED: ReadonlyArray<
  readonly [string, number, number, "square" | "portrait" | "landscape"]
> = [
  ["social-square", 1080, 1080, "square"],
  ["social-portrait", 1080, 1350, "portrait"],
  ["social-tall", 1080, 1440, "portrait"],
  ["story-vertical", 1080, 1920, "portrait"],
  ["social-landscape", 1200, 630, "landscape"],
  ["video-landscape", 1920, 1080, "landscape"],
  ["certificate-a4-landscape", 3508, 2480, "landscape"],
  ["certificate-a4-portrait", 2480, 3508, "portrait"],
  ["badge-landscape", 1011, 638, "landscape"],
];

describe("size presets", () => {
  it("ships the nine presets with exact ids, dimensions and orientation", () => {
    expect(SIZE_PRESETS).toHaveLength(9);
    expect(SIZE_PRESETS.map((preset) => preset.id)).toEqual(EXPECTED.map((entry) => entry[0]));
    for (const [id, width, height, orientation] of EXPECTED) {
      const preset = size(id);
      expect(preset.width).toBe(width);
      expect(preset.height).toBe(height);
      expect(preset.orientation).toBe(orientation);
      expect(preset.label.es.length).toBeGreaterThan(0);
      expect(preset.label.en.length).toBeGreaterThan(0);
    }
  });

  it("maps orientations and filters by orientation", () => {
    expect(sizeOrientation("social-square")).toBe("square");
    expect(sizeOrientation("certificate-a4-portrait")).toBe("portrait");
    expect(sizeOrientation("badge-landscape")).toBe("landscape");
    expect(sizesForOrientation("square").map((preset) => preset.id)).toEqual(["social-square"]);
    expect(sizesForOrientation("portrait").map((preset) => preset.id)).toEqual([
      "social-portrait",
      "social-tall",
      "story-vertical",
      "certificate-a4-portrait",
    ]);
    expect(sizesForOrientation("landscape")).toHaveLength(4);
  });

  it("declares the story safe area in pixels and nowhere else", () => {
    expect(size("story-vertical").safeArea).toEqual({ top: 250, bottom: 250, left: 80, right: 80 });
    for (const preset of SIZE_PRESETS) {
      if (preset.id !== "story-vertical") expect(preset.safeArea).toBeUndefined();
    }
  });

  it("records print metadata at 300 ppi for certificates and badge", () => {
    expect(size("certificate-a4-landscape").print).toEqual({
      ppi: 300,
      widthMm: 297,
      heightMm: 210,
    });
    expect(size("certificate-a4-portrait").print).toEqual({
      ppi: 300,
      widthMm: 210,
      heightMm: 297,
    });
    expect(size("badge-landscape").print).toEqual({ ppi: 300, widthMm: 85.6, heightMm: 54 });
    for (const preset of SIZE_PRESETS) {
      if (!preset.id.startsWith("certificate") && preset.id !== "badge-landscape") {
        expect(preset.print).toBeUndefined();
      }
    }
  });

  it("resolves family defaults and rejects unknown presets", () => {
    expect(defaultSizeForFamily("social")).toBe("social-portrait");
    expect(defaultSizeForFamily("personalized")).toBe("certificate-a4-portrait");
    expect(defaultSizeForFamily("composite")).toBe("social-square");
    expect(defaultSizeForFamily("chart")).toBe("social-square");
    expect(defaultSizeForFamily("dynamic")).toBe("social-portrait");
    expect(captureError(() => size("nope")).code).toBe("UNKNOWN_SIZE");
    expect(captureError(() => defaultSizeForFamily("nope")).code).toBe("INVALID_SPEC");
  });
});
