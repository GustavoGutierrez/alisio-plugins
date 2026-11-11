import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("coordinate grid figure", () => {
  it("plots each named point at its coordinates in the first quadrant", () => {
    const svg = render({
      kind: "coordinate-grid",
      params: { max: 6, quadrants: 1, points: [{ x: 2, y: 3, name: "A" }] },
    });
    // cell = floor(260 / 6) capped at 24; origin at (30, 30 + 6 * 24).
    expect(svg).toContain('<circle cx="78" cy="102" r="4"');
    expect(svg).toContain("Puntos marcados: A.");
  });

  it("spans four quadrants and drops points outside the grid", () => {
    const svg = render({
      kind: "coordinate-grid",
      params: {
        max: 5,
        points: [
          { x: -2, y: -3, name: "B" },
          { x: 9, y: 0, name: "Z" },
        ],
      },
    });
    expect(count(svg, /<circle /g)).toBe(1);
    expect(svg).toContain(">-5<");
    expect(svg).not.toContain(">Z<");
  });
});
