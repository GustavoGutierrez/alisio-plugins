import { describe, expect, it } from "vitest";
import {
  CALIBRATION_MUTATIONS,
  calibrateCase,
  channelToleranceFrom,
  DEFAULT_ACCEPTABLE,
  labelMutations,
  validatorQuality,
} from "../src/domain/fidelity/calibration.js";
import { diffMask, regionMetrics, validPixels } from "../src/domain/fidelity/regions.js";
import { clonePng, fillRect, solid } from "./helpers/png.js";

const sample = (dR: number, qK: number) => ({ dR, qK, k: 16 });

describe("channel tolerance (spec 11.4 step 2)", () => {
  it("is the largest channel difference seen on unchanged captures", () => {
    expect(channelToleranceFrom([])).toEqual({ ok: true, tolerance: 0 });
    expect(channelToleranceFrom([0, 0, 0])).toEqual({ ok: true, tolerance: 0 });
    expect(channelToleranceFrom([0, 3, 1])).toEqual({ ok: true, tolerance: 3 });
    expect(channelToleranceFrom([8])).toEqual({ ok: true, tolerance: 8 });
  });

  it("above 8 the environment is unstable (CAL-002) and the tolerance is not raised", () => {
    const result = channelToleranceFrom([2, 9]);
    expect(result).toMatchObject({ ok: false, code: "CAL-002" });
    if (!result.ok) expect(result.message).toContain("unstable environment");
  });
});

describe("mutations (spec 11.4 step 3)", () => {
  it("lists the deterministic mutations and labels the 2 px translations acceptable by default", () => {
    expect(CALIBRATION_MUTATIONS).toHaveLength(10);
    expect(DEFAULT_ACCEPTABLE).toEqual(["translate-x-2", "translate-y-2"]);
    const labels = labelMutations();
    expect(labels.filter((m) => !m.defect).map((m) => m.id)).toEqual([
      "translate-x-2",
      "translate-y-2",
    ]);
    expect(labels.filter((m) => m.defect)).toHaveLength(8);
  });

  it("lets the contract relabel what is acceptable", () => {
    const labels = labelMutations(["translate-x-4", "color-shift-16"]);
    expect(labels.filter((m) => !m.defect).map((m) => m.id)).toEqual([
      "translate-x-4",
      "color-shift-16",
    ]);
  });
});

describe("limits per region (spec 11.4 step 4)", () => {
  const input = (repetitions: number[], defects: number[], acceptable: number[] = []) => ({
    channelTolerance: 0,
    repetitions: repetitions.map((d) => ({ regions: { cards: sample(d, d * 10) } })),
    mutations: [
      ...defects.map((d, i) => ({
        id: `defect-${i}`,
        defect: true,
        regions: { cards: sample(d, d * 10) },
      })),
      ...acceptable.map((d, i) => ({
        id: `fine-${i}`,
        defect: false,
        regions: { cards: sample(d, d * 10) },
      })),
    ],
  });

  it("puts the limit between the worst noise u and the smallest defect v", () => {
    const calibrated = calibrateCase(input([0, 0.001, 0.002], [0.05, 0.04, 0.1]), 0.5);
    const region = calibrated.regions.cards;
    expect(region).toMatchObject({ k: 16, u_d: 0.002, v_d: 0.04, status: "OK" });
    expect(region?.limit_d).toBeCloseTo(0.021, 12);
    expect(region?.u_q).toBeCloseTo(0.02, 12);
    expect(region?.v_q).toBeCloseTo(0.4, 12);
    expect(region?.limit_q).toBeCloseTo(0.21, 12);
  });

  it("honours calibrationPosition", () => {
    const quarter = calibrateCase(input([0], [0.04]), 0.25).regions.cards;
    expect(quarter?.limit_d).toBeCloseTo(0.01, 12);
  });

  it("is UNSEPARABLE when noise reaches the smallest defect: raising a tolerance is not a fix", () => {
    const calibrated = calibrateCase(input([0.03, 0.05], [0.04, 0.1]), 0.5).regions.cards;
    expect(calibrated).toMatchObject({
      status: "UNSEPARABLE",
      limit_d: null,
      limit_q: null,
      u_d: 0.05,
      v_d: 0.04,
    });
    const equal = calibrateCase(input([0.04], [0.04]), 0.5).regions.cards;
    expect(equal?.status).toBe("UNSEPARABLE");
  });

  it("is UNSEPARABLE when no defect mutation produced a metric for the region", () => {
    expect(calibrateCase(input([0], []), 0.5).regions.cards).toMatchObject({
      status: "UNSEPARABLE",
      v_d: null,
    });
  });

  it("ignores defect mutations that left the region untouched (no-ops are no evidence)", () => {
    const calibrated = calibrateCase(input([0], [0, 0.05, 0.08]), 0.5).regions.cards;
    expect(calibrated).toMatchObject({ v_d: 0.05, status: "OK" });
    expect(calibrateCase(input([0], [0, 0]), 0.5).regions.cards?.status).toBe("UNSEPARABLE");
  });

  it("calibrates every region that appears and keeps the channel tolerance", () => {
    const calibrated = calibrateCase(
      {
        channelTolerance: 3,
        repetitions: [{ regions: { a: sample(0, 0), b: sample(0, 0) } }],
        mutations: [
          { id: "m", defect: true, regions: { a: sample(0.1, 0.5), b: sample(0.2, 0.6) } },
        ],
      },
      0.5,
    );
    expect(Object.keys(calibrated.regions)).toEqual(["a", "b"]);
    expect(calibrated.channelTolerance).toBe(3);
  });
});

describe("validator quality (FID 15.8)", () => {
  it("reports sensitivity TP/(TP+FN) and false positive rate FP/(FP+TN) over the labelled set", () => {
    const set = {
      channelTolerance: 0,
      repetitions: [
        { regions: { cards: sample(0, 0) } },
        { regions: { cards: sample(0.001, 0.01) } },
      ],
      mutations: [
        { id: "d1", defect: true, regions: { cards: sample(0.05, 0.5) } },
        { id: "d2", defect: true, regions: { cards: sample(0.04, 0.4) } },
        { id: "a1", defect: false, regions: { cards: sample(0.002, 0.02) } },
      ],
    };
    const calibrated = calibrateCase(set, 0.5);
    expect(validatorQuality(set, calibrated.regions)).toEqual({
      sensitivity: 1,
      falsePositiveRate: 0,
      tp: 2,
      fn: 0,
      fp: 0,
      tn: 3,
    });
    const weak = {
      ...set,
      mutations: [
        ...set.mutations,
        { id: "d3", defect: true, regions: { cards: sample(0.0005, 0.005) } },
      ],
    };
    const quality = validatorQuality(weak, calibrated.regions);
    expect(quality.fn).toBe(1);
    expect(quality.sensitivity).toBeCloseTo(2 / 3, 12);
  });

  it("has no rate when a class is empty", () => {
    const empty = { channelTolerance: 0, repetitions: [], mutations: [] };
    expect(validatorQuality(empty, {})).toEqual({
      sensitivity: null,
      falsePositiveRate: null,
      tp: 0,
      fn: 0,
      fp: 0,
      tn: 0,
    });
  });
});

describe("calibration over real pixel mutations", () => {
  it("separates 4 and 8 px translations from noise while keeping the 2 px one acceptable", () => {
    const baseline = solid(120, 80);
    fillRect(baseline, 20, 20, 40, 24, [0, 0, 0, 255]);
    const shifted = (dx: number) => {
      const image = solid(120, 80);
      fillRect(image, 20 + dx, 20, 40, 24, [0, 0, 0, 255]);
      return image;
    };
    const region = { x: 0, y: 0, width: 120, height: 80 };
    const valid = validPixels(120, 80, []);
    const measure = (image: ReturnType<typeof solid>) => {
      const m = regionMetrics(
        diffMask(baseline.data, image.data, 120, 80, 0),
        valid,
        120,
        80,
        region,
        16,
      );
      return { dR: m.dR, qK: m.qK, k: m.k };
    };
    const set = {
      channelTolerance: 0,
      repetitions: [measure(clonePng(baseline)), measure(clonePng(baseline))].map((s) => ({
        regions: { page: s },
      })),
      mutations: [
        { id: "translate-x-2", defect: false, regions: { page: measure(shifted(2)) } },
        { id: "translate-x-4", defect: true, regions: { page: measure(shifted(4)) } },
        { id: "translate-x-8", defect: true, regions: { page: measure(shifted(8)) } },
      ],
    };
    const calibrated = calibrateCase(set, 0.5);
    expect(calibrated.regions.page?.status).toBe("OK");
    expect(calibrated.regions.page?.u_d).toBe(0);
    const quality = validatorQuality(set, calibrated.regions);
    expect(quality).toMatchObject({ sensitivity: 1, falsePositiveRate: 0 });
  });
});
