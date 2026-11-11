import { describe, expect, it } from "vitest";
import { evaluateCurve } from "../../src/figures/index.js";
import { count, render } from "./helpers.js";

describe("function-plot figure", () => {
  it("draws the curve inside the window, numbered axes and the named points", () => {
    const svg = render({
      kind: "function-plot",
      params: {
        xMin: -5,
        xMax: 5,
        yMin: -6,
        yMax: 8,
        curves: [{ type: "polynomial", coefficients: [-3, -2, 1] }],
        points: [{ x: 1, y: -4, name: "V" }],
      },
    });
    expect(count(svg, /<path d="M/g)).toBe(1);
    expect(svg).toContain('fill="none" stroke="#000" stroke-width="2"');
    expect(svg).toContain(">V</text>");
    expect(svg).toContain("Puntos marcados: V (1, -4).");
    expect(svg).toContain("<title>Gráfica de una función</title>");
  });

  it("evaluates polynomials, exponentials and logarithms exactly as the families do", () => {
    expect(evaluateCurve({ type: "polynomial", coefficients: [-3, -2, 1] }, 1)).toBe(-4);
    expect(evaluateCurve({ type: "exponential", a: 3, base: 2 }, 3)).toBe(24);
    expect(evaluateCurve({ type: "logarithm", base: 10 }, 1000)).toBeCloseTo(3, 12);
    expect(evaluateCurve({ type: "logarithm", base: 2 }, -1)).toBeNaN();
  });

  it("drops points outside the window and ignores malformed curves", () => {
    const svg = render({
      kind: "function-plot",
      params: { curves: [{ type: "nope" }, "x"], points: [{ x: 99, y: 0, name: "Z" }] },
    });
    expect(svg).not.toContain(">Z<");
    expect(svg).not.toContain('<path d="M');
  });
});
