import { describe, expect, it } from "vitest";
import { fitScale, LEGIBLE_SCALE, MIN_SCALE, printableArea } from "../src/fit.js";

describe("printable area", () => {
  it("subtracts the 12 mm margins at 96 px per inch", () => {
    expect(printableArea("A4")).toEqual({ width: 702, height: 1031 });
    expect(printableArea("Letter")).toEqual({ width: 725, height: 965 });
  });
});

describe("fitScale", () => {
  it("keeps content that already fits at full size", () => {
    expect(fitScale("A4", 702, 900)).toEqual({ scale: 1, small: false, overflow: false });
  });

  it("shrinks tall content so it fits the page height exactly", () => {
    const { scale } = fitScale("A4", 702, 2062);
    expect(scale).toBe(0.5);
    expect(2062 * scale).toBeLessThanOrEqual(printableArea("A4").height);
  });

  it("never rounds up past the page", () => {
    for (const height of [1032, 1500, 1777, 2999, 4100]) {
      const { scale } = fitScale("Letter", 725, height);
      expect(height * scale).toBeLessThanOrEqual(printableArea("Letter").height);
    }
  });

  it("also fits content wider than the printable width", () => {
    expect(fitScale("A4", 1404, 500).scale).toBe(0.5);
  });

  it("is deterministic", () => {
    expect(fitScale("A4", 702, 1800)).toEqual(fitScale("A4", 702, 1800));
  });

  it("warns below the legible scale and flags overflow below the minimum", () => {
    const small = fitScale("A4", 702, 1031 / (LEGIBLE_SCALE - 0.05));
    expect(small.small).toBe(true);
    expect(small.overflow).toBe(false);
    const huge = fitScale("A4", 702, 1031 / (MIN_SCALE / 2));
    expect(huge).toMatchObject({ scale: MIN_SCALE, overflow: true });
  });

  it.each([
    [0, 10],
    [10, 0],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
    [-1, 5],
  ])("rejects an invalid measurement %s x %s", (w, h) => {
    expect(() => fitScale("A4", w, h)).toThrow("invalid_measurement");
  });
});
