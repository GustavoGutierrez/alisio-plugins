import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("box-plot figure", () => {
  it("draws the box from Q1 to Q3 with the median and a numbered axis", () => {
    const svg = render({
      kind: "box-plot",
      params: { min: 3, q1: 5.5, median: 7, q3: 10, max: 14, axisMin: 0, axisMax: 16, step: 2 },
    });
    expect(count(svg, /<rect /g)).toBe(1);
    for (const tick of ["0", "8", "16"]) expect(svg).toContain(`>${tick}</text>`);
    expect(svg).toContain("Mínimo 3, primer cuartil 5,5, mediana 7, tercer cuartil 10, máximo 14.");
    expect(svg).not.toContain(">5,5</text>");
  });

  it("writes the five numbers over the plot with showValues", () => {
    const svg = render({
      kind: "box-plot",
      params: { min: 2, q1: 4, median: 6.5, q3: 9, max: 12, step: 2, showValues: true },
    });
    expect(svg).toContain(">6,5</text>");
  });
});
