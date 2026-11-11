import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("cube stack figure", () => {
  it("draws one cube (front, top, side) per unit cube", () => {
    const svg = render({ kind: "cube-stack", params: { length: 3, width: 2, height: 2 } });
    expect(count(svg, /<rect /g)).toBe(12);
    expect(count(svg, /<polygon /g)).toBe(24);
    expect(svg).toContain("3 cubos de largo, 2 de ancho y 2 de alto.");
  });

  it("caps each edge at six cubes", () => {
    const svg = render({ kind: "cube-stack", params: { length: 40, width: 1, height: 1 } });
    expect(count(svg, /<rect /g)).toBe(6);
  });
});
