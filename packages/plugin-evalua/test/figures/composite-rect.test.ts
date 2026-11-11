import { describe, expect, it } from "vitest";
import { compositeVertices } from "../../src/figures/index.js";
import { render } from "./helpers.js";

const sideLabels = (svg: string) =>
  /Lados, desde la base en sentido antihorario: ([^.]*)\./.exec(svg)?.[1];

describe("composite rectangle figure", () => {
  it("labels every side of an L-shape with its true length", () => {
    const svg = render({
      kind: "composite-rect",
      params: { width: 6, height: 5, cutWidth: 2, cutHeight: 3, unit: "cm" },
    });
    expect(sideLabels(svg)).toBe("6 cm, 2 cm, 2 cm, 3 cm, 4 cm, 5 cm");
    expect(svg).toContain("Figura en forma de L");
    expect(compositeVertices(6, 5, 2, 3)).toHaveLength(6);
  });

  it("draws a plain rectangle with hidden sides and an optional unit grid", () => {
    const svg = render({
      kind: "composite-rect",
      params: { width: 4, height: 3, hidden: [1, 3], grid: true },
    });
    expect(sideLabels(svg)).toBe("4, ?, 4, ?");
    expect(svg.match(/stroke="#9a9a9a"/g)).toHaveLength(3 + 2);
  });

  it("keeps the cut inside the rectangle", () => {
    expect(compositeVertices(3, 3, 0, 2)).toHaveLength(4);
    const svg = render({
      kind: "composite-rect",
      params: { width: 3, height: 3, cutWidth: 9, cutHeight: 9 },
    });
    expect(sideLabels(svg)).toBe("3, 1, 2, 2, 1, 3");
  });
});
