import { describe, expect, it } from "vitest";
import { parsePath, toBezierPath } from "../src/renderers/svg-path.js";
import { captureError } from "./helpers.js";

describe("parsePath", () => {
  it("parses mixed absolute and relative commands", () => {
    expect(parsePath("M 10 20 l 5 5 L 30 40 h 10 v -5 Z")).toEqual([
      { type: "M", x: 10, y: 20 },
      { type: "L", x: 15, y: 25 },
      { type: "L", x: 30, y: 40 },
      { type: "L", x: 40, y: 40 },
      { type: "L", x: 40, y: 35 },
      { type: "Z" },
    ]);
  });

  it("parses scientific notation, signs and comma separators", () => {
    expect(parsePath("M 1e2 2.5e1 L-3.2E-1,+4")).toEqual([
      { type: "M", x: 100, y: 25 },
      { type: "L", x: -0.32, y: 4 },
    ]);
  });

  it("repeats lineto for extra coordinate pairs after a moveto", () => {
    expect(parsePath("M 0 0 10 10 20 20")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 10 },
      { type: "L", x: 20, y: 20 },
    ]);
  });

  it("repeats commands for implicit parameter runs", () => {
    expect(parsePath("M 0 0 L 1 1 2 2 3 3")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 1, y: 1 },
      { type: "L", x: 2, y: 2 },
      { type: "L", x: 3, y: 3 },
    ]);
  });

  it("normalizes H, V, S and T shorthands into absolute coordinates", () => {
    expect(parsePath("M 0 0 H 10 V 20 S 30 20 40 30 T 60 30")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 10, y: 20 },
      { type: "C", cp1x: 10, cp1y: 20, cp2x: 30, cp2y: 20, x: 40, y: 30 },
      { type: "Q", cpx: 40, cpy: 30, x: 60, y: 30 },
    ]);
  });

  it("reflects relative smooth curve controls", () => {
    expect(parsePath("m 0 0 c 0 0 0 0 10 0 s 10 0 10 10")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "C", cp1x: 0, cp1y: 0, cp2x: 0, cp2y: 0, x: 10, y: 0 },
      { type: "C", cp1x: 20, cp1y: 0, cp2x: 20, cp2y: 0, x: 20, y: 10 },
    ]);
  });

  it("parses arcs with flags, including adjacent flags and absolute radii", () => {
    expect(parsePath("M 0 0 A5 5 0 0110 0")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "A", rx: 5, ry: 5, rotation: 0, largeArc: false, sweep: true, x: 10, y: 0 },
    ]);
    expect(parsePath("M 0 0 a 5 10 45 1 0 20 0")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "A", rx: 5, ry: 10, rotation: 45, largeArc: true, sweep: false, x: 20, y: 0 },
    ]);
    expect(parsePath("M 0 0 A -5 -10 0 0 1 20 0")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "A", rx: 5, ry: 10, rotation: 0, largeArc: false, sweep: true, x: 20, y: 0 },
    ]);
  });

  it("keeps multiple subpaths and closepath commands", () => {
    expect(parsePath("M0 0 L10 0 Z M20 20 L30 20 Z")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "Z" },
      { type: "M", x: 20, y: 20 },
      { type: "L", x: 30, y: 20 },
      { type: "Z" },
    ]);
  });

  it("turns a zero-radius arc into a lineto", () => {
    expect(parsePath("M 0 0 A 0 10 0 0 1 10 0")).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
    ]);
  });
});

describe("toBezierPath", () => {
  it("converts lines, quadratics and cubics losslessly", () => {
    const [subpath] = toBezierPath(parsePath("M 0 0 L 10 0 Q 3 0 3 3 C 4 4 5 5 6 6 Z"));
    expect(subpath).toBeDefined();
    expect(subpath?.closed).toBe(true);
    expect(subpath?.segments).toHaveLength(3);
    expect(subpath?.segments[0]).toEqual({
      cp1x: 0,
      cp1y: 0,
      cp2x: 10,
      cp2y: 0,
      x: 10,
      y: 0,
    });
    const quadratic = subpath?.segments[1];
    expect(quadratic?.cp1x).toBeCloseTo(16 / 3, 10);
    expect(quadratic?.cp1y).toBeCloseTo(0, 10);
    expect(quadratic?.cp2x).toBeCloseTo(3, 10);
    expect(quadratic?.cp2y).toBeCloseTo(1, 10);
    expect(quadratic?.x).toBe(3);
    expect(quadratic?.y).toBe(3);
    expect(subpath?.segments[2]).toEqual({
      cp1x: 4,
      cp1y: 4,
      cp2x: 5,
      cp2y: 5,
      x: 6,
      y: 6,
    });
  });

  it("splits half circles into two cubic segments ending at the arc endpoint", () => {
    const [subpath] = toBezierPath(parsePath("M 0 0 A 10 10 0 0 1 20 0"));
    expect(subpath?.segments).toHaveLength(2);
    const last = subpath?.segments[1];
    expect(last?.x).toBeCloseTo(20, 6);
    expect(last?.y).toBeCloseTo(0, 6);
    // sweep = 1 goes through negative y in canvas coordinates
    for (const segment of subpath?.segments ?? []) {
      expect(segment.y).toBeLessThanOrEqual(1e-6);
      expect(segment.cp1y).toBeLessThanOrEqual(1e-6);
      expect(segment.cp2y).toBeLessThanOrEqual(1e-6);
    }
  });

  it("splits three-quarter arcs into three cubic segments", () => {
    const [subpath] = toBezierPath(parsePath("M 10 0 A 10 10 0 1 1 0 10"));
    expect(subpath?.segments).toHaveLength(3);
    const last = subpath?.segments[2];
    expect(last?.x).toBeCloseTo(0, 6);
    expect(last?.y).toBeCloseTo(10, 6);
  });

  it("drops arcs with identical endpoints and lines zero radii", () => {
    const identical = toBezierPath(parsePath("M 5 5 A 10 10 0 0 1 5 5"));
    expect(identical).toHaveLength(1);
    expect(identical[0]?.segments).toHaveLength(0);
    expect(identical[0]?.closed).toBe(false);

    const zeroRadius = toBezierPath(parsePath("M 0 0 A 0 10 0 0 1 10 0"));
    expect(zeroRadius[0]?.segments).toHaveLength(1);
    expect(zeroRadius[0]?.segments[0]?.x).toBe(10);
    expect(zeroRadius[0]?.segments[0]?.y).toBe(0);
  });

  it("scales radii up when the chord does not fit", () => {
    const [subpath] = toBezierPath(parsePath("M 0 0 A 1 1 0 0 1 10 0"));
    expect(subpath?.segments).toHaveLength(2);
    expect(subpath?.segments[1]?.x).toBeCloseTo(10, 6);
    expect(subpath?.segments[1]?.y).toBeCloseTo(0, 6);
  });

  it("starts a new subpath after closepath and keeps both subpaths", () => {
    const subpaths = toBezierPath(parsePath("M 0 0 L 10 0 Z L 20 20"));
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]?.closed).toBe(true);
    expect(subpaths[1]?.x).toBe(0);
    expect(subpaths[1]?.y).toBe(0);
    expect(subpaths[1]?.segments[0]?.x).toBe(20);
    expect(subpaths[1]?.segments[0]?.y).toBe(20);
    expect(subpaths[1]?.closed).toBe(false);
  });

  it("converts an arc into an unclosed subpath when there is no Z", () => {
    const [subpath] = toBezierPath(parsePath("M 0 0 A 5 5 0 0 1 10 0"));
    expect(subpath?.closed).toBe(false);
  });
});

describe("invalid path data", () => {
  it("rejects empty path data", () => {
    const error = captureError(() => parsePath("   "));
    expect(error.code).toBe("INVALID_SPEC");
  });

  it("rejects path data that does not start with moveto", () => {
    const error = captureError(() => parsePath("L 10 10"));
    expect(error.code).toBe("INVALID_SPEC");
    expect(String(error.details?.token).startsWith("L")).toBe(true);
  });

  it("includes the offending token in the error details", () => {
    const error = captureError(() => parsePath("M 10 x"));
    expect(error.code).toBe("INVALID_SPEC");
    expect(String(error.details?.token).startsWith("x")).toBe(true);

    const unclosed = captureError(() => parsePath("M 0 0 L 1 1 #"));
    expect(unclosed.code).toBe("INVALID_SPEC");
    expect(unclosed.details?.token).toBe("#");
  });

  it("rejects invalid arc flags", () => {
    const error = captureError(() => parsePath("M 0 0 A 10 10 0 2 0 5 5"));
    expect(error.code).toBe("INVALID_SPEC");
    expect(String(error.details?.token).startsWith("2")).toBe(true);
  });

  it("rejects numbers after a closepath", () => {
    const error = captureError(() => parsePath("M 0 0 Z 5 5"));
    expect(error.code).toBe("INVALID_SPEC");
    expect(String(error.details?.token).startsWith("5")).toBe(true);
  });

  it("rejects unsupported command letters", () => {
    const error = captureError(() => parsePath("M 0 0 R 1 1"));
    expect(error.code).toBe("INVALID_SPEC");
    expect(String(error.details?.token).startsWith("R")).toBe(true);
  });
});
