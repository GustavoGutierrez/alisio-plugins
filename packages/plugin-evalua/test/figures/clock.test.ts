import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

const hand = (svg: string, width: string) =>
  new RegExp(
    `<line x1="100" y1="100" x2="([\\d.-]+)" y2="([\\d.-]+)" stroke-width="${width}"/>`,
  ).exec(svg);

describe("clock figure", () => {
  it("draws twelve numerals, sixty ticks and both hands", () => {
    const svg = render({ kind: "clock", params: { hour: 3, minute: 0 } });
    expect(count(svg, /<text /g)).toBe(12);
    expect(count(svg, /stroke-width="(1\.6|0\.7)"/g)).toBe(60);
    // 3:00 -> the hour hand points right (east), the minute hand straight up.
    const hour = hand(svg, "4.5");
    expect(Number(hour?.[1])).toBeCloseTo(141, 0);
    expect(Number(hour?.[2])).toBeCloseTo(100, 0);
    const minute = hand(svg, "2.2");
    expect(Number(minute?.[1])).toBeCloseTo(100, 0);
    expect(Number(minute?.[2])).toBeLessThan(40);
  });

  it("moves the hour hand with the minutes and describes the hands, not the time", () => {
    const svg = render({ kind: "clock", params: { hour: 3, minute: 30 } });
    const hour = hand(svg, "4.5");
    // Halfway between 3 and 4: below the horizontal.
    expect(Number(hour?.[2])).toBeGreaterThan(100);
    expect(svg).toContain("entre el 3 y el 4");
    expect(svg).toContain("la manecilla larga señala el 6");
    expect(svg).not.toContain("3:30");
  });

  it("clamps out-of-range params", () => {
    const svg = render({ kind: "clock", params: { hour: 99, minute: -5 } });
    expect(svg).toContain("la manecilla corta señala el 12");
  });
});
