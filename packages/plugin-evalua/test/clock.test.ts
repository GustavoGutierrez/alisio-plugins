import { describe, expect, it } from "vitest";
import { fixedClock, schoolYear, systemClock } from "../src/clock.js";

describe("clock", () => {
  it("derives the school year from the injected clock", () => {
    expect(schoolYear(fixedClock("2026-10-06T12:00:00.000Z"))).toBe(2026);
    expect(schoolYear(fixedClock("2031-01-02T00:00:00.000Z"))).toBe(2031);
  });

  it("system clock returns a current date", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(5000);
  });

  it("fixedClock rejects invalid input", () => {
    expect(() => fixedClock("nope")).toThrow();
  });
});
