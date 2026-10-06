import { describe, expect, it } from "vitest";
import { largestComponent } from "../src/domain/fidelity/components.js";
import { boxError, coordinateErrors, mean, summarize } from "../src/domain/fidelity/geometry.js";
import { integralImage, maxWindow, rectSum } from "../src/domain/fidelity/integral.js";
import {
  diffMask,
  globalMatchPercent,
  regionMetrics,
  validPixels,
} from "../src/domain/fidelity/regions.js";
import { relationValue } from "../src/domain/fidelity/relations.js";
import {
  canonicalColor,
  familyValue,
  normalizeText,
  pxValue,
  weightValue,
} from "../src/domain/fidelity/typography.js";
import { clonePng, fillRect, solid } from "./helpers/png.js";

/** The experiment of spec Appendix C: an 800x600 white image with a 16x16 black marker. */
const reference = solid(800, 600);
fillRect(reference, 100, 100, 16, 16, [0, 0, 0, 255]);
const missing = solid(800, 600);
const scattered = clonePng(reference);
for (let y = 0; y < 16; y += 1)
  for (let x = 0; x < 16; x += 1)
    fillRect(scattered, 20 + 40 * x, 200 + 20 * y, 1, 1, [0, 0, 0, 255]);
const marker = { x: 100, y: 100, width: 16, height: 16 };
const whole = { x: 0, y: 0, width: 800, height: 600 };
const count = (mask: Uint8Array): number => mask.reduce((n, v) => n + v, 0);

describe("metrics experiment (Appendix C)", () => {
  const missingMask = diffMask(reference.data, missing.data, 800, 600);
  const scatteredMask = diffMask(reference.data, scattered.data, 800, 600);
  const valid = validPixels(800, 600, []);

  it("a missing marker and 256 scattered points both differ in 256 pixels and match 99.946667 percent globally", () => {
    expect(count(missingMask)).toBe(256);
    expect(count(scatteredMask)).toBe(256);
    expect(globalMatchPercent(missingMask).toFixed(6)).toBe("99.946667");
    expect(globalMatchPercent(scatteredMask).toFixed(6)).toBe("99.946667");
  });

  it("the maximum 16x16 window density tells them apart: 100 percent against 0.390625 percent", () => {
    const missingWindow = regionMetrics(missingMask, valid, 800, 600, whole, 16);
    const scatteredWindow = regionMetrics(scatteredMask, valid, 800, 600, whole, 16);
    expect(missingWindow.qK * 100).toBe(100);
    expect(scatteredWindow.qK * 100).toBe(0.390625);
    expect(missingWindow.k).toBe(16);
  });

  it("the critical region of the marker diff is 100 percent when it is missing and 0 when it is not", () => {
    expect(regionMetrics(missingMask, valid, 800, 600, marker, 16).dR * 100).toBe(100);
    expect(regionMetrics(scatteredMask, valid, 800, 600, marker, 16).dR * 100).toBe(0);
  });

  it("the largest connected component separates a block from dust", () => {
    expect(regionMetrics(missingMask, valid, 800, 600, whole, 16).largestComponent).toBe(256);
    expect(regionMetrics(scatteredMask, valid, 800, 600, whole, 16).largestComponent).toBe(1);
  });

  it("100 boxes with one shifted 8 px: the mean error is 0.02 px and the maximum 8", () => {
    const boxes = Array.from({ length: 100 }, () => ({ x: 100, y: 100, width: 200, height: 100 }));
    const shifted = boxes.map((box, i) => (i === 0 ? { ...box, x: box.x + 8 } : box));
    const errors = coordinateErrors(boxes, shifted);
    expect(errors).toHaveLength(400);
    expect(mean(errors)).toBeCloseTo(0.02, 12);
    expect(Math.max(...errors)).toBe(8);
    const perElement = boxes.map((box, i) => boxError(box, shifted[i] as typeof box).e);
    const summary = summarize(perElement);
    expect(summary).toEqual({ median: 0, p95: 0, max: 8, count: 100 });
  });
});

describe("pixel difference definition (spec 11.3)", () => {
  it("a pixel differs when any RGBA channel differs by more than the tolerance", () => {
    const a = solid(2, 1, [100, 100, 100, 255]);
    const b = solid(2, 1, [100, 100, 100, 255]);
    b.data.set([103, 100, 100, 255], 0);
    b.data.set([100, 100, 100, 250], 4);
    expect([...diffMask(a.data, b.data, 2, 1, 0)]).toEqual([1, 1]);
    expect([...diffMask(a.data, b.data, 2, 1, 3)]).toEqual([0, 1]);
    expect([...diffMask(a.data, b.data, 2, 1, 5)]).toEqual([0, 0]);
  });

  it("masked pixels leave numerator and denominator", () => {
    const a = solid(10, 10);
    const b = solid(10, 10);
    fillRect(b, 0, 0, 5, 10, [0, 0, 0, 255]);
    const mask = diffMask(a.data, b.data, 10, 10);
    const region = { x: 0, y: 0, width: 10, height: 10 };
    expect(regionMetrics(mask, validPixels(10, 10, []), 10, 10, region, 4).dR).toBe(0.5);
    const masked = regionMetrics(
      mask,
      validPixels(10, 10, [{ x: 0, y: 0, width: 5, height: 10 }]),
      10,
      10,
      region,
      4,
    );
    expect(masked).toMatchObject({ dR: 0, qK: 0, validPixels: 50, differingPixels: 0 });
    const allMasked = regionMetrics(mask, validPixels(10, 10, [region]), 10, 10, region, 4);
    expect(allMasked).toMatchObject({ dR: 0, validPixels: 0 });
  });

  it("a region smaller than the window uses its own smaller side", () => {
    const a = solid(20, 20);
    const b = solid(20, 20);
    fillRect(b, 2, 2, 4, 4, [0, 0, 0, 255]);
    const mask = diffMask(a.data, b.data, 20, 20);
    const metrics = regionMetrics(
      mask,
      validPixels(20, 20, []),
      20,
      20,
      { x: 2, y: 2, width: 4, height: 4 },
      16,
    );
    expect(metrics.k).toBe(4);
    expect(metrics.qK).toBe(1);
  });
});

describe("integral image and components", () => {
  it("answers every rectangle sum like brute force", () => {
    let state = 12345;
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    const w = 37;
    const h = 23;
    const mask = new Uint8Array(w * h).map(() => (next() % 5 === 0 ? 1 : 0));
    const table = integralImage(mask, w, h);
    for (let trial = 0; trial < 60; trial += 1) {
      const rect = {
        x: next() % w,
        y: next() % h,
        width: 1 + (next() % 10),
        height: 1 + (next() % 10),
      };
      let expected = 0;
      for (let y = rect.y; y < Math.min(h, rect.y + rect.height); y += 1)
        for (let x = rect.x; x < Math.min(w, rect.x + rect.width); x += 1)
          expected += mask[y * w + x] as number;
      const clipped = {
        ...rect,
        width: Math.min(rect.width, w - rect.x),
        height: Math.min(rect.height, h - rect.y),
      };
      expect(rectSum(table, w, clipped)).toBe(expected);
    }
    expect(maxWindow(table, w, { x: 0, y: 0, width: w, height: h }, 5).count).toBeGreaterThan(0);
  });

  it("uses 4-connectivity and does not overflow the stack on a large block", () => {
    const mask = new Uint8Array(9);
    mask[0] = 1;
    mask[4] = 1;
    mask[8] = 1;
    expect(largestComponent(mask, 3, 3)).toBe(1);
    const block = new Uint8Array(1000 * 1000).fill(1);
    expect(largestComponent(block, 1000, 1000)).toBe(1_000_000);
    expect(largestComponent(block, 1000, 1000, { x: 10, y: 10, width: 5, height: 4 })).toBe(20);
  });
});

describe("geometry, relations and canonical values", () => {
  it("geometry error is the largest coordinate difference and the vector is kept", () => {
    expect(
      boxError({ x: 0, y: 0, width: 10, height: 10 }, { x: 2, y: -3, width: 10, height: 15 }),
    ).toEqual({ dx: 2, dy: 3, dw: 0, dh: 5, e: 5 });
  });

  it("summarises with the median, the nearest-rank p95 and the maximum", () => {
    expect(summarize([])).toEqual({ median: 0, p95: 0, max: 0, count: 0 });
    expect(summarize([3, 1, 2])).toEqual({ median: 2, p95: 3, max: 3, count: 3 });
    expect(summarize([1, 2, 3, 4]).median).toBe(2.5);
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
  });

  it("measures the relations of FID 15.4", () => {
    const toolbar = { x: 24, y: 0, width: 600, height: 48 };
    const cards = { x: 24, y: 80, width: 600, height: 400 };
    expect(relationValue("gapVertical", toolbar, cards)).toBe(32);
    expect(
      relationValue(
        "gapHorizontal",
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 18, y: 0, width: 10, height: 10 },
      ),
    ).toBe(8);
    expect(relationValue("alignLeft", toolbar, cards)).toBe(0);
    expect(relationValue("alignTop", toolbar, cards)).toBe(-80);
    expect(relationValue("alignRight", toolbar, { ...cards, width: 580 })).toBe(20);
    expect(relationValue("sameWidth", toolbar, { ...cards, width: 580 })).toBe(20);
  });

  it("canonicalises CSS values before comparing", () => {
    expect(pxValue("18px")).toBe(18);
    expect(pxValue(" 18.5 ")).toBe(18.5);
    expect(pxValue("normal")).toBeUndefined();
    expect(pxValue("1.5em")).toBeUndefined();
    expect(weightValue("bold")).toBe(700);
    expect(weightValue("600")).toBe(600);
    expect(weightValue("heavy")).toBeUndefined();
    expect(familyValue('"Inter", system-ui, sans-serif')).toBe("inter");
    expect(canonicalColor("rgb(37, 99, 235)")).toBe("#2563EB");
    expect(canonicalColor("rgba(0, 0, 0, 0.5)")).toBe("#00000080");
    expect(canonicalColor("#fff")).toBe("#FFFFFF");
    expect(canonicalColor("oklch(0.5 0.1 200)")).toBeUndefined();
    expect(normalizeText("  Create \n\t project ")).toBe("Create project");
  });
});
