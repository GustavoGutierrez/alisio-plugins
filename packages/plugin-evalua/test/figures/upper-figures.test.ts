import { describe, expect, it } from "vitest";
import { evaluateCurve, type FigureSpec, figureSvg } from "../../src/figures/index.js";
import { count, render } from "./helpers.js";

/**
 * Every `<text>` of an SVG with a box estimated from its size (about 0.55 em per character), so a
 * test can prove no label is clipped by the viewBox.
 */
function textBoxes(svg: string) {
  const [, width = "0", height = "0"] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
  const boxes = [
    ...svg.matchAll(
      /<text x="([-\d.]+)" y="([-\d.]+)" font-size="(\d+)"(?: text-anchor="(\w+)")?[^>]*>([^<]*)<\/text>/g,
    ),
  ].map(([, x = "0", y = "0", size = "12", anchor = "start", value = ""]) => {
    const w = value.length * Number(size) * 0.55;
    const left =
      anchor === "middle" ? Number(x) - w / 2 : anchor === "end" ? Number(x) - w : Number(x);
    return { left, right: left + w, top: Number(y) - Number(size), bottom: Number(y) + 2, value };
  });
  return { boxes, width: Number(width), height: Number(height) };
}

function expectInside(spec: FigureSpec): string {
  const svg = render(spec);
  const { boxes, width, height } = textBoxes(svg);
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left, box.value).toBeGreaterThanOrEqual(0);
    expect(box.right, box.value).toBeLessThanOrEqual(width);
    expect(box.top, box.value).toBeGreaterThanOrEqual(0);
    expect(box.bottom, box.value).toBeLessThanOrEqual(height);
  }
  return svg;
}

describe("unit-circle figure", () => {
  it("draws the circle, the angle arc with its label and the named terminal point", () => {
    for (const angle of [30, 135, 210, 300, 330]) {
      const svg = expectInside({
        kind: "unit-circle",
        params: { angle, angleLabel: `${angle}°`, point: "P", projections: true },
      });
      expect(svg).toContain(`>${angle}°</text>`);
      expect(svg).toContain(">P</text>");
      expect(count(svg, /stroke-dasharray="4 3"/g)).toBe(2);
      expect(svg).toContain("<title>Circunferencia unitaria</title>");
      expect(svg).toContain(`Ángulo de ${angle}°`);
    }
  });

  it("never centres the angle label on the y axis", () => {
    const svg = render({ kind: "unit-circle", params: { angle: 180, angleLabel: "π" } });
    expect(svg).toMatch(/text-anchor="start"[^>]*>π</);
  });
});

describe("conic figure", () => {
  it("draws a circle with its centre and radius on a numbered grid", () => {
    const svg = expectInside({ kind: "conic", params: { shape: "circle", h: -2, k: 3, r: 4 } });
    expect(svg).toContain(">C</text>");
    expect(svg).toContain(">r</text>");
    expect(svg).toContain("Circunferencia de centro C(-2, 3) y radio 4.");
  });

  it("draws a parabola with its focus and dashed directrix along either axis", () => {
    const up = expectInside({ kind: "conic", params: { shape: "parabola", p: 2 } });
    expect(up).toContain("foco F(0, 2)");
    expect(up).toContain("y = -2");
    const left = expectInside({
      kind: "conic",
      params: { shape: "parabola", p: -1.5, axis: "horizontal" },
    });
    expect(left).toContain("foco F(-1.5, 0)");
    expect(left).toContain("x = 1.5");
    expect(count(left, /stroke-dasharray="5 3"/g)).toBe(1);
  });
});

describe("number line with intervals", () => {
  it("draws filled and hollow ends and arrows for infinite ends", () => {
    const svg = expectInside({
      kind: "number-line",
      params: {
        min: -6,
        max: 6,
        intervals: [
          { from: null, to: -2, fromClosed: false, toClosed: true },
          { from: 3, to: null, fromClosed: false, toClosed: false },
        ],
      },
    });
    expect(count(svg, /r="5.5" fill="#000"/g)).toBe(1);
    expect(count(svg, /r="5.5" fill="#ffffff"/g)).toBe(1);
    expect(svg).toContain("de menos infinito a -2 (incluido); y de 3 (excluido) a infinito");
  });

  it("keeps the plain and the labelled number lines unchanged", () => {
    expect(figureSvg({ kind: "number-line", params: { min: 0, max: 4 } })).not.toContain(
      "Intervalo",
    );
  });
});

describe("right triangle with a marked angle and sinusoid curves", () => {
  it("marks θ at the asked vertex and says so", () => {
    for (const angleAt of ["A", "B"] as const) {
      const svg = expectInside({
        kind: "triangle",
        params: { legs: [4, 3], sideLabels: ["4 cm", "3 cm", "5 cm"], angleAt, angleLabel: "θ" },
      });
      expect(svg).toContain(">θ</text>");
      expect(svg).toContain(`Ángulo θ marcado en ${angleAt}.`);
    }
    const plain = render({ kind: "triangle", params: { legs: [4, 3] } });
    expect(plain).not.toContain("θ");
  });

  it("evaluates a sinusoid with its amplitude and period, and plots it", () => {
    const curve = { type: "sinusoid", fn: "sin", amplitude: 3, period: 4, shift: 0 } as const;
    expect(evaluateCurve(curve, 1)).toBeCloseTo(3, 12);
    expect(evaluateCurve(curve, 3)).toBeCloseTo(-3, 12);
    expect(evaluateCurve({ ...curve, fn: "cos" }, 4)).toBeCloseTo(3, 12);
    const svg = render({
      kind: "function-plot",
      params: { xMin: -4, xMax: 4, yMin: -4, yMax: 4, curves: [curve] },
    });
    expect(count(svg, /<path d="M/g)).toBe(1);
  });

  it("leaves out a tick number that a curve or a point name would cover", () => {
    // y = x crosses the x axis labels only at 0 (the axis), so every tick survives...
    const line = render({
      kind: "function-plot",
      params: {
        xMin: -3,
        xMax: 3,
        yMin: -3,
        yMax: 3,
        curves: [{ type: "polynomial", coefficients: [0, 1] }],
      },
    });
    expect(line).toContain(">2</text>");
    // ...while a sine crossing the axis at every whole number covers those tick numbers.
    const wave = render({
      kind: "function-plot",
      params: {
        xMin: -4,
        xMax: 4,
        yMin: -3,
        yMax: 3,
        curves: [{ type: "sinusoid", fn: "sin", amplitude: 2, period: 2, shift: 0 }],
      },
    });
    expect(wave).not.toMatch(/font-size="9" text-anchor="middle"[^>]*>3<\/text>/);
  });
});
